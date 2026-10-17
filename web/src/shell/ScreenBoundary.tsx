import { Component, type ReactNode } from "react";
import { EmptyState } from "./components";

interface Props {
  /** Shown in the message, for example "Map". */
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Stops one screen's crash (a map that cannot start, a bad file) from blanking the whole app. */
export class ScreenBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3">
        <EmptyState title={`${this.props.name} could not be shown`}>{error.message}</EmptyState>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded-full border border-border bg-surface-strong px-4 py-2 text-body hover:border-accent"
        >
          Try again
        </button>
      </div>
    );
  }
}
