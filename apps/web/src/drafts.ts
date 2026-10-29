import type { ConversationAttachmentRef, DraftState } from '../../../contracts/contracts';
import { RequestError } from './api';

export interface DraftCapture { text: string; attachmentRefs: ConversationAttachmentRef[]; generation: number }
export interface DraftView {
  server: DraftState;
  text: string;
  attachmentRefs: ConversationAttachmentRef[];
  generation: number;
  dirty: boolean;
  saving: boolean;
  conflict: DraftState | null;
  error: string | null;
}
interface DraftEntry extends DraftView {
  write: Pick<DraftState, 'text' | 'revision' | 'key' | 'attachmentRefs'> | null;
  task: Promise<DraftState> | null;
  submission: { capture: DraftCapture; saved: DraftState } | null;
}
export function draftContentSignature(value: { text: string; attachmentRefs?: readonly ConversationAttachmentRef[] }): string {
  return JSON.stringify([value.text, (value.attachmentRefs ?? []).map((ref) => [ref.fileRefId, ref.version, ref.category, ref.displayName ?? null])]);
}
const sameContent = (a: { text: string; attachmentRefs?: readonly ConversationAttachmentRef[] }, b: { text: string; attachmentRefs?: readonly ConversationAttachmentRef[] }) => draftContentSignature(a) === draftContentSignature(b);
const copyRefs = (refs?: readonly ConversationAttachmentRef[]) => (refs ?? []).map((ref) => ({ ...ref }));

// Core owns saved drafts. This buffer fences only edits still in flight in this page.
export class Drafts {
  private readonly entries = new Map<string, DraftEntry>();
  constructor(private readonly write: (id: string, draft: Pick<DraftState, 'key' | 'text' | 'revision' | 'attachmentRefs'>)
    => Promise<DraftState>, private readonly changed: () => void) {}

  get(id: string): DraftView | null { return this.entries.get(id) ?? null; }
  receive(id: string, incoming: DraftState, reset = false): void {
    const entry = this.entries.get(id);
    if (!entry) {
      this.entries.set(id, { server: incoming, text: incoming.text, attachmentRefs: copyRefs(incoming.attachmentRefs), generation: 0,
        dirty: false, saving: false, conflict: null, error: null, write: null, task: null, submission: null });
      this.changed();
      return;
    }
    if (!reset && incoming.key === entry.server.key && incoming.revision <= entry.server.revision) return;
    if (incoming.key === entry.server.key && incoming.revision === entry.server.revision
      && sameContent(incoming, entry.server)) return;
    const ownWrite = entry.write?.key === incoming.key && sameContent(entry.write, incoming)
      && incoming.revision === entry.write.revision + 1;
    const ownRetirement = entry.submission?.saved.key === incoming.key && incoming.text === '' && !(incoming.attachmentRefs ?? []).length
      && incoming.revision > entry.submission.saved.revision;
    // 已受理请求可能在旧页面收到回执前推进草稿版本；空的新基线不是新编辑内容，
    // 保留本页较新的文字，不把旧回执当成冲突或清空目标。
    const emptyBaseline = incoming.text === '' && !(incoming.attachmentRefs ?? []).length && incoming.revision > entry.server.revision;
    const untouched = !entry.dirty && !entry.write && !entry.submission;
    entry.server = incoming;
    if (untouched) { entry.text = incoming.text; entry.attachmentRefs = copyRefs(incoming.attachmentRefs); }
    else if (!sameContent(incoming, entry) && !ownWrite && !ownRetirement && !emptyBaseline) entry.conflict = incoming;
    entry.dirty = !sameContent(entry, incoming);
    if (!entry.dirty) { entry.conflict = null; entry.error = null; }
    this.changed();
  }
  edit(id: string, text: string): void {
    const entry = this.require(id);
    if (entry.text === text) return;
    entry.text = text;
    entry.generation++;
    entry.dirty = !sameContent(entry, entry.server);
    entry.error = null;
    this.changed();
  }
  setAttachments(id: string, refs: readonly ConversationAttachmentRef[]): void {
    const entry = this.require(id), next = copyRefs(refs);
    if (sameContent(entry, { text: entry.text, attachmentRefs: next })) return;
    entry.attachmentRefs = next;
    entry.generation++;
    entry.dirty = !sameContent(entry, entry.server);
    entry.error = null;
    this.changed();
  }
  capture(id: string): DraftCapture {
    const entry = this.require(id);
    return { text: entry.text, attachmentRefs: copyRefs(entry.attachmentRefs), generation: entry.generation };
  }
  async persist(id: string, capture = this.capture(id)): Promise<DraftState> {
    const entry = this.require(id);
    while (entry.task) await entry.task;
    if (entry.conflict) throw new Error('草稿已在其他页面修改，请先选择保留哪一份。');
    if (sameContent(entry.server, capture)) {
      if (sameContent(entry, capture)) { entry.error = null; entry.dirty = false; this.changed(); }
      return entry.server;
    }
    entry.write = { key: entry.server.key, text: capture.text, attachmentRefs: copyRefs(capture.attachmentRefs), revision: entry.server.revision };
    entry.saving = true;
    entry.error = null;
    this.changed();
    const task = this.write(id, entry.write).then((saved) => {
      this.receive(id, saved);
      return saved;
    }).catch((error: unknown) => {
      entry.error = error instanceof Error ? error.message : '草稿暂未保存。';
      if (error instanceof RequestError && error.code === 'DRAFT_CONFLICT' && error.draft) {
        entry.server = error.draft;
        entry.conflict = sameContent(entry, error.draft) ? null : error.draft;
        if (!entry.conflict) entry.error = null;
      }
      throw error;
    }).finally(() => {
      entry.write = null;
      entry.task = null;
      entry.saving = false;
      entry.dirty = !sameContent(entry, entry.server);
      this.changed();
    });
    entry.task = task;
    return task;
  }
  /** 等待所有已知草稿落盘；版本冲突或不可写时拒绝离开当前页面。 */
  async flushAndWait(canWrite: (id: string) => boolean): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.task) await entry.task;
      if (entry.conflict) throw new Error('还有草稿版本冲突，请先核对保留哪一份。');
      if (!entry.dirty && entry.error && sameContent(entry.server, entry)) { entry.error = null; this.changed(); }
      if (entry.dirty) {
        if (!canWrite(id)) throw new Error('还有输入正在提交或草稿暂不可保存，请稍后再退出。');
        await this.persist(id);
      }
      if (entry.dirty || entry.saving || entry.conflict || entry.error) throw new Error('还有草稿未确认保存，请先核对。');
    }
  }
  beginSubmission(id: string, capture: DraftCapture, saved: DraftState): void {
    this.require(id).submission = { capture, saved };
  }
  /** 只有服务端确认退休本轮修订时才清空；较新的编辑或未退休修订继续保留。 */
  settleSubmission(id: string, capture: DraftCapture, accepted: boolean, clear = accepted): void {
    const entry = this.require(id);
    if (accepted && clear && entry.generation === capture.generation && sameContent(entry, capture)) {
      entry.text = '';
      entry.attachmentRefs = [];
      entry.generation++;
    }
    entry.submission = null;
    entry.dirty = !sameContent(entry, entry.server);
    this.changed();
  }
  resolveConflict(id: string, choice: 'local' | 'saved'): void {
    const entry = this.require(id);
    if (choice === 'saved') { entry.text = entry.server.text; entry.attachmentRefs = copyRefs(entry.server.attachmentRefs); entry.generation++; }
    entry.conflict = null;
    entry.error = null;
    entry.dirty = !sameContent(entry, entry.server);
    this.changed();
  }
  flush(allowed: (id: string) => boolean = () => true): void {
    for (const [id, entry] of this.entries) {
      if (allowed(id) && entry.dirty && !entry.saving && !entry.error && !entry.conflict && !entry.submission) {
        void this.persist(id).catch(() => {});
      }
    }
  }
  private require(id: string): DraftEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('草稿尚未加载。');
    return entry;
  }
}
