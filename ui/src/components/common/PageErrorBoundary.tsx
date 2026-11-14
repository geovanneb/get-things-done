import React from 'react';
import EmptyState from './EmptyState';
import { tr } from '@/i18n/current';

interface Props {
  /** Changes when the user goes to another page: the next page gets a fresh start. */
  resetKey: string;
  children: React.ReactNode;
}

/**
 * Keeps a page that failed to draw from taking the whole dashboard with it. Without it React removes everything,
 * sidebar included, and leaves a blank window with no message. The sidebar and header stay, so the user can go
 * elsewhere, and the workspace check in Settings names a file the app cannot use.
 */
export default class PageErrorBoundary extends React.Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('[page] could not be shown:', error);
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert">
        <EmptyState
          title={tr('pageError.title')}
          description={tr('pageError.description')}
          action={{ label: tr('pageError.reload'), onClick: () => window.location.reload() }}
        />
      </div>
    );
  }
}
