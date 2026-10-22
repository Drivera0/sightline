"""The AWS pieces with fake clients: SQS FIFO queue + S3 originals, CloudWatch, Secrets Manager."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sightline.mission.aws import CloudWatchMetrics, SqsQueue, load_secrets
from sightline.mission.pipeline import PhotoJob


class FakeSqs:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.deleted: list[str] = []
        self.inbox: list[dict] = []

    def send_message(self, **kw) -> None:
        self.sent.append(kw)
        self.inbox.append({"Body": kw["MessageBody"], "ReceiptHandle": f"rh{len(self.sent)}"})

    def receive_message(self, **kw) -> dict:
        assert kw["WaitTimeSeconds"] == 20 and kw["MaxNumberOfMessages"] == 1
        return {"Messages": [self.inbox.pop(0)]} if self.inbox else {}

    def delete_message(self, **kw) -> None:
        self.deleted.append(kw["ReceiptHandle"])


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def upload_file(self, path: str, bucket: str, key: str) -> None:
        self.objects[f"{bucket}/{key}"] = Path(path).read_bytes()

    def download_file(self, bucket: str, key: str, path: str) -> None:
        Path(path).write_bytes(self.objects[f"{bucket}/{key}"])


JOB = PhotoJob("a1b2c3d4", "f0001", "frames/orig/f0001.jpg", "2026-10-24T21:40:00Z", "DJI_0001.JPG")


def _queue(tmp_path: Path) -> tuple[SqsQueue, FakeSqs, FakeS3]:
    sqs, s3 = FakeSqs(), FakeS3()
    q = SqsQueue("https://sqs/q.fifo", bucket="b", store_root=tmp_path / "api", sqs=sqs, s3=s3)
    orig = tmp_path / "api" / JOB.mission_id / JOB.orig_rel
    orig.parent.mkdir(parents=True)
    orig.write_bytes(b"jpeg")
    return q, sqs, s3


def test_put_keeps_the_original_in_s3_and_orders_jobs_per_mission(tmp_path: Path) -> None:
    q, sqs, s3 = _queue(tmp_path)
    q.put(JOB)
    assert s3.objects == {"b/missions/a1b2c3d4/orig/f0001.jpg": b"jpeg"}
    msg = sqs.sent[0]
    assert msg["MessageGroupId"] == "a1b2c3d4" and msg["MessageDeduplicationId"] == "a1b2c3d4-f0001"
    assert PhotoJob(**json.loads(msg["MessageBody"])) == JOB


def test_the_worker_fetches_the_original_handles_and_deletes(tmp_path: Path) -> None:
    q, sqs, _ = _queue(tmp_path)
    q.put(JOB)
    worker = SqsQueue(
        "https://sqs/q.fifo", bucket="b", store_root=tmp_path / "worker", sqs=sqs, s3=q.s3
    )
    seen: list[PhotoJob] = []
    assert worker.poll_once(seen.append) == 1
    assert seen == [JOB] and sqs.deleted == ["rh1"]
    assert (tmp_path / "worker" / JOB.mission_id / JOB.orig_rel).read_bytes() == b"jpeg"


def test_a_failed_job_stays_on_the_queue(tmp_path: Path) -> None:
    q, sqs, _ = _queue(tmp_path)
    q.put(JOB)

    def boom(job: PhotoJob) -> None:
        raise RuntimeError("detector crashed")

    assert q.poll_once(boom) == 0 and sqs.deleted == []  # SQS retries it, then the DLQ


def test_metrics() -> None:
    sent: list[list[dict]] = []

    class Cw:
        def put_metric_data(self, Namespace: str, MetricData: list[dict]) -> None:
            assert Namespace == "Sightline"
            sent.append(MetricData)

    m = CloudWatchMetrics(Cw())
    m.photo({"ms": {"pose": 10, "detect": 1800}, "total_ms": 1810, "candidates": 2})
    m.photo({"frame": "f0001", "skipped": "already processed"})
    m.trace(type("E", (), {"kind": "model_call"})())
    m.trace(type("E", (), {"kind": "note"})())
    names = [
        [(d["MetricName"], d.get("Dimensions", [{}])[0].get("Value")) for d in batch]
        for batch in sent
    ]
    assert names == [
        [
            ("PhotoLatencyMs", "pose"),
            ("PhotoLatencyMs", "detect"),
            ("PhotoLatencyMs", "total"),
            ("DetectionsPerPhoto", None),
        ],
        [("AgentModelCalls", None)],
    ]


def test_secrets_load_into_the_environment_without_overriding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Sm:
        def get_secret_value(self, SecretId: str) -> dict:
            assert SecretId == "sightline/api-keys"
            return {
                "SecretString": json.dumps({"NEBIUS_API_KEY": "n-123", "TAVILY_API_KEY": "t-456"})
            }

    monkeypatch.delenv("NEBIUS_API_KEY", raising=False)
    monkeypatch.setenv("TAVILY_API_KEY", "already-set")
    monkeypatch.setenv("SIGHTLINE_SECRET_ID", "sightline/api-keys")
    assert load_secrets(Sm()) == ["NEBIUS_API_KEY"]
    import os

    assert os.environ["NEBIUS_API_KEY"] == "n-123" and os.environ["TAVILY_API_KEY"] == "already-set"
    monkeypatch.delenv("SIGHTLINE_SECRET_ID")
    assert load_secrets(Sm()) == []
