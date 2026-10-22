"""AWS pieces of the live pipeline (LANE_D §5.7, D-W1): the SQS photo queue, CloudWatch metrics and
secrets from Secrets Manager. ``boto3`` (the ``aws`` extra) is imported only when one is used;
every client can be passed in (tests).

- ``SqsQueue``: a **FIFO** queue, one message group per mission, so each mission's photos are
  handled in upload order (frame ids are given out at upload). ``put`` copies the original to S3
  (``missions/<id>/orig/``) and sends the job; the worker long-polls, downloads the original if
  its disk doesn't have it, runs the handler and deletes the message only after success. A
  message that fails 3 times goes to the dead-letter queue (the queue's redrive policy,
  ``deploy/aws/setup.sh``). Duplicates are harmless: ``ingest_photo`` skips a frame it has.
- ``CloudWatchMetrics``: ``PhotoLatencyMs`` (per step and total), ``DetectionsPerPhoto``,
  ``AgentModelCalls``, namespace ``Sightline``.
- ``load_secrets``: ``NEBIUS_API_KEY`` / ``TAVILY_API_KEY`` from the JSON secret
  ``SIGHTLINE_SECRET_ID`` into the environment at start-up (never written anywhere).

Done by lane A for lane D (issue #51); lane D owns this file.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any

from sightline.mission.pipeline import PhotoJob

log = logging.getLogger(__name__)

NAMESPACE = "Sightline"
SECRET_KEYS = ("NEBIUS_API_KEY", "TAVILY_API_KEY")


def _client(name: str) -> Any:
    import boto3

    return boto3.client(name)


class SqsQueue:
    def __init__(
        self,
        queue_url: str,
        *,
        bucket: str | None,
        store_root: Path,
        sqs: Any = None,
        s3: Any = None,
        wait_s: int = 20,
        visibility_s: int = 300,
    ) -> None:
        self.queue_url, self.bucket, self.store_root = queue_url, bucket, Path(store_root)
        self.sqs = sqs or _client("sqs")
        self.s3 = s3 if s3 is not None else (_client("s3") if bucket else None)
        self.wait_s, self.visibility_s = wait_s, visibility_s
        self._stop = threading.Event()

    @classmethod
    def from_env(cls, store_root: Path) -> SqsQueue:
        return cls(
            os.environ["SIGHTLINE_SQS_URL"],
            bucket=os.environ.get("SIGHTLINE_S3_BUCKET") or None,
            store_root=store_root,
        )

    def _key(self, job: PhotoJob) -> str:
        return f"missions/{job.mission_id}/orig/{Path(job.orig_rel).name}"

    def put(self, job: PhotoJob) -> None:
        if self.bucket:
            self.s3.upload_file(
                str(self.store_root / job.mission_id / job.orig_rel), self.bucket, self._key(job)
            )
        self.sqs.send_message(
            QueueUrl=self.queue_url,
            MessageBody=json.dumps(asdict(job)),
            MessageGroupId=job.mission_id,
            MessageDeduplicationId=f"{job.mission_id}-{job.frame_id}",
        )

    def run_worker(self, handler: Callable[[PhotoJob], None]) -> None:
        """Blocks: receive, handle, delete; until ``stop()``."""
        while not self._stop.is_set():
            self.poll_once(handler)

    def poll_once(self, handler: Callable[[PhotoJob], None]) -> int:
        r = self.sqs.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=self.wait_s,
            VisibilityTimeout=self.visibility_s,
        )
        handled = 0
        for msg in r.get("Messages", []):
            job = PhotoJob(**json.loads(msg["Body"]))
            local = self.store_root / job.mission_id / job.orig_rel
            try:
                if not local.is_file() and self.bucket:
                    local.parent.mkdir(parents=True, exist_ok=True)
                    self.s3.download_file(self.bucket, self._key(job), str(local))
                handler(job)
            except Exception:  # left on the queue: retried, then the dead-letter queue
                log.exception("photo job %s/%s failed", job.mission_id, job.frame_id)
                continue
            self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=msg["ReceiptHandle"])
            handled += 1
        return handled

    def stop(self) -> None:
        self._stop.set()


class CloudWatchMetrics:
    """Per-photo timings and counts, and agent model calls, to CloudWatch (namespace Sightline)."""

    def __init__(self, cloudwatch: Any = None) -> None:
        self.cw = cloudwatch or _client("cloudwatch")

    def _put(self, data: list[dict]) -> None:
        try:
            self.cw.put_metric_data(Namespace=NAMESPACE, MetricData=data)
        except Exception:  # metrics never stop the pipeline
            log.exception("CloudWatch put_metric_data failed")

    def photo(self, summary: dict) -> None:
        if "ms" not in summary:  # a skipped duplicate
            return
        data = [
            {
                "MetricName": "PhotoLatencyMs",
                "Dimensions": [{"Name": "Step", "Value": step}],
                "Value": float(ms),
                "Unit": "Milliseconds",
            }
            for step, ms in summary["ms"].items()
        ]
        data.append(
            {
                "MetricName": "PhotoLatencyMs",
                "Dimensions": [{"Name": "Step", "Value": "total"}],
                "Value": float(summary["total_ms"]),
                "Unit": "Milliseconds",
            }
        )
        data.append(
            {
                "MetricName": "DetectionsPerPhoto",
                "Value": float(summary["candidates"]),
                "Unit": "Count",
            }
        )
        self._put(data)

    def trace(self, entry: Any) -> None:
        if getattr(entry, "kind", None) == "model_call":
            self._put([{"MetricName": "AgentModelCalls", "Value": 1.0, "Unit": "Count"}])


def metrics_from_env() -> CloudWatchMetrics | None:
    return CloudWatchMetrics() if os.environ.get("SIGHTLINE_METRICS") == "cloudwatch" else None


def load_secrets(secrets: Any = None) -> list[str]:
    """Copy the API keys from the JSON secret ``SIGHTLINE_SECRET_ID`` into the environment (keys
    already set win). Returns the names loaded, never the values."""
    secret_id = os.environ.get("SIGHTLINE_SECRET_ID")
    if not secret_id:
        return []
    sm = secrets or _client("secretsmanager")
    values = json.loads(sm.get_secret_value(SecretId=secret_id)["SecretString"])
    loaded = []
    for k in SECRET_KEYS:
        if values.get(k) and not os.environ.get(k):
            os.environ[k] = values[k]
            loaded.append(k)
    return loaded
