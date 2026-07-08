import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { ImageAttachment, PendingAttachment } from '@/utils/MessageQueue2';

// MessageQueue2.push carries pasted images (3rd) before per-message attachments
// (4th). Codex text has no pasted images, so `images` is always undefined here.
type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, images?: ImageAttachment[], attachments?: PendingAttachment[]) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[]) => void;
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
    attachments?: PendingAttachment[];
}): 'clear' | 'queued' {
    if (isCodexClearText(opts.text)) {
        opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments);
        return 'clear';
    }

    opts.queue.push(opts.text, opts.mode, undefined, opts.attachments);
    return 'queued';
}
