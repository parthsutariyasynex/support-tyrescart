'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type ConversationSummary, fetchConversationSummary, generateConversationSummary, suggestReply } from '@/lib/ai';
import { GqlError } from '@/lib/api';
import { formatDateTime } from '@/lib/time';

// "AI Assistant" tab beside Reply / Add note. AI Summary (owners, admins and supervisors): the saved summary, who
// made it and when, Generate / Regenerate. AI Reply (whoever may reply): a suggestion to edit here, then "Use this
// reply" puts it in the message box; sending it asks for confirmation first (ConfirmAiSend).
export function AiAssistantPanel({
  conversationId,
  canSummarize,
  canReply,
  replyBlocked,
  onUseReply,
}: {
  conversationId: string;
  canSummarize: boolean;
  canReply: boolean;
  // Why a reply can't be sent now (e.g. the 24-hour window closed); null when it can
  replyBlocked: string | null;
  onUseReply: (text: string) => void;
}) {
  const [summary, setSummary] = useState<ConversationSummary | null>(null);
  const [summaryState, setSummaryState] = useState<'loading' | 'idle' | 'busy'>('loading');
  const [summaryError, setSummaryError] = useState('');
  const [reply, setReply] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState('');
  // The team already answered the customer's latest message: a note, not an error (nothing to suggest)
  const [replyNote, setReplyNote] = useState('');
  const current = useRef(conversationId);

  useEffect(() => {
    current.current = conversationId;
    setSummary(null);
    setSummaryError('');
    setReply('');
    setReplyError('');
    setReplyNote('');
    if (!canSummarize) return;
    setSummaryState('loading');
    fetchConversationSummary(conversationId)
      .then((s) => current.current === conversationId && setSummary(s))
      .catch((err) => current.current === conversationId && setSummaryError((err as Error).message))
      .finally(() => current.current === conversationId && setSummaryState('idle'));
  }, [conversationId, canSummarize]);

  const generate = async () => {
    setSummaryState('busy');
    setSummaryError('');
    try {
      const s = await generateConversationSummary(conversationId);
      if (current.current === conversationId) setSummary(s);
    } catch (err) {
      if (current.current === conversationId) setSummaryError((err as Error).message);
    } finally {
      if (current.current === conversationId) setSummaryState('idle');
    }
  };

  const draft = async () => {
    setReplyBusy(true);
    setReplyError('');
    setReplyNote('');
    try {
      const text = await suggestReply(conversationId);
      if (current.current === conversationId) setReply(text);
    } catch (err) {
      if (current.current !== conversationId) return;
      if (err instanceof GqlError && err.code === 'ALREADY_ANSWERED') {
        setReply('');
        setReplyNote(err.message);
      } else setReplyError((err as Error).message);
    } finally {
      if (current.current === conversationId) setReplyBusy(false);
    }
  };

  const button = 'rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50';
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-3 text-xs" aria-label="AI Assistant">
      {canSummarize && (
        <section aria-labelledby="ai-summary-title">
          <div className="flex items-center justify-between gap-2">
            <h3 id="ai-summary-title" className="text-[11px] font-bold uppercase tracking-wide text-ink">
              AI Summary
            </h3>
            <button type="button" disabled={summaryState !== 'idle'} onClick={generate} className={`${button} bg-primary-subtle text-primary hover:bg-primary-subtle/80`}>
              {summaryState === 'busy' ? 'Writing…' : summary ? 'Regenerate' : 'Generate summary'}
            </button>
          </div>
          {summaryState === 'loading' ? (
            <p className="mt-2 text-muted">Loading…</p>
          ) : summary ? (
            <>
              <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed text-body">{summary.summary}</p>
              <p className="mt-1.5 text-[11px] text-muted">
                {summary.updatedByName ? `By ${summary.updatedByName}, ` : ''}
                {formatDateTime(summary.updatedAt)}
                {!summary.upToDate && <span className="ml-1.5 font-semibold text-warning">· New messages since this summary</span>}
              </p>
              {/* Regenerate with nothing new: the AI wasn't asked (messages from the last couple of seconds wait for the next try) */}
              {summary.addedMessages === 0 && (
                <p role="status" className="mt-1 text-[11px] text-muted">
                  {summary.upToDate ? 'Already up to date: no new messages since the last summary.' : 'The newest messages just arrived. Try again in a few seconds.'}
                </p>
              )}
            </>
          ) : (
            !summaryError && <p className="mt-2 text-muted">No summary yet for this chat.</p>
          )}
          {summaryError && (
            <p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-1.5 text-danger">
              {summaryError}
            </p>
          )}
        </section>
      )}

      {canReply && (
        <section aria-labelledby="ai-reply-title" className={canSummarize ? 'border-t border-line-soft pt-3' : ''}>
          <div className="flex items-center justify-between gap-2">
            <h3 id="ai-reply-title" className="text-[11px] font-bold uppercase tracking-wide text-ink">
              AI Reply
            </h3>
            <button type="button" disabled={replyBusy || !!replyBlocked} onClick={draft} className={`${button} bg-primary text-on-primary hover:bg-primary-hover`}>
              {replyBusy ? 'Writing…' : reply ? 'Try again' : 'AI Reply'}
            </button>
          </div>
          {replyBlocked ? (
            <p className="mt-2 text-muted">{replyBlocked}</p>
          ) : reply ? (
            <>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={4}
                aria-label="AI reply suggestion"
                className="mt-2 w-full resize-y rounded-lg border border-line bg-page px-3 py-2 text-[13px] leading-relaxed text-ink focus:border-primary focus:outline-none"
              />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">Edit it here or in the message box. It is sent only after you confirm.</span>
                <button type="button" disabled={!reply.trim()} onClick={() => onUseReply(reply.trim())} className={`${button} border border-primary text-primary hover:bg-primary-subtle`}>
                  Use this reply
                </button>
              </div>
            </>
          ) : (
            !replyError && !replyNote && <p className="mt-2 text-muted">Writes a reply to the customer&apos;s latest message for you to check and edit.</p>
          )}
          {replyNote && (
            <p role="status" className="mt-2 flex items-start gap-1.5 rounded-lg bg-success-soft px-3 py-1.5 text-body">
              <span aria-hidden="true">✓</span>
              {replyNote}
            </p>
          )}
          {replyError && (
            <p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-1.5 text-danger">
              {replyError}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

// Before an AI-written reply goes to the customer: the exact text, Cancel or Send. On the page itself (a portal): the
// composer sits inside the chat pane, which would otherwise clip it.
export function ConfirmAiSend(props: { text: string; onCancel: () => void; onConfirm: () => void }) {
  return createPortal(<ConfirmAiSendDialog {...props} />, document.body);
}

function ConfirmAiSendDialog({ text, onCancel, onConfirm }: { text: string; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-shadow/40 p-4 sm:items-center" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ai-send-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-surface p-5 text-ink-soft shadow-xl"
      >
        <h2 id="ai-send-title" className="text-sm font-bold text-ink">
          Send this AI reply?
        </h2>
        <p className="mt-1 text-xs text-muted">This message was written with AI. Check it before it goes to the customer on WhatsApp.</p>
        <p className="mt-3 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-muted px-3 py-2 text-[13px] leading-relaxed text-ink">{text}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-strong">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
