import ShowInFolderButton from '@/components/common/ShowInFolderButton';
import { apiGet } from '@/utils/api';
import { meetingFolderTarget } from '@/utils/meetingHistory';
import type { MeetingFolder } from '@/types';

/**
 * Open folder for a meeting: asks the server where its files are now (queue, its own folder, or its update's
 * materials) only when clicked, then opens it in the desktop app or shows the path in a browser.
 */
export default function OpenMeetingFolder({ id, iconOnly = true }: { id: string; iconOnly?: boolean }) {
  return (
    <ShowInFolderButton iconOnly={iconOnly}
      path={async () => meetingFolderTarget(await apiGet<MeetingFolder>(`/api/meetings/${encodeURIComponent(id)}/folder`))} />
  );
}
