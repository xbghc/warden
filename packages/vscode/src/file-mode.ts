import type { FileEntry } from '@warden/shared';

/**
 * A change of Git file mode on a file that exists on both sides: the executable bit, or a file
 * becoming a symbolic link. An added or deleted file has a mode on one side only, which is not a
 * change of mode and is already said by the file being added or deleted.
 */
export const fileModeChange = (file: Pick<FileEntry, 'oldMode' | 'newMode'>): string | undefined =>
  file.oldMode && file.newMode && file.oldMode !== file.newMode ? `File mode ${file.oldMode} → ${file.newMode}` : undefined;
