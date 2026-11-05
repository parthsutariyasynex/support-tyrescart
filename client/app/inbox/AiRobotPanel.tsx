'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AI_ROBOT_EVENT, type AiRobotRun, type AiRobotStatus, RUN_LABELS, countdown, fetchAiRobotChat, stopAiRobot, toolText } from '@/lib/aiRobot';
import { formatDateTime } from '@/lib/time';
import { ConfirmDialog } from '../ConfirmDialog';

// The chat's "AI Robot" tab beside Reply / Add note / AI Reply / AI Summary (server: services/aiRobot.ts). Everyone who
// sees the chat sees it, while the robot is on in the workspace (or has worked in this chat): where it stands (with a
// countdown while it waits), Stop robot, its latest draft in draft mode ("Use this reply" sends it as your message,
// after the same confirmation as AI Reply), and its decisions in this chat with what it looked up.

export type AiRobotChat = { status: AiRobotStatus; runs: AiRobotRun[] } | null;

// The robot's status and history in this chat: loaded when the chat opens, when its messages change (refreshKey: the
// latest message id), when the robot does something here (socket ai-robot:state, relayed as AI_ROBOT_EVENT) and just
// after its countdown runs out
export function useAiRobotChat(conversationId: string, refreshKey: string | undefined) {
  const [data, setData] = useState<AiRobotChat>(null);
  const current = useRef(conversationId);
  const reload = useCallback(() => {
    const id = conversationId;
    fetchAiRobotChat(id)
      .then((d) => current.current === id && setData({ status: d.aiRobotStatus, runs: d.aiRobotRuns }))
      .catch(() => {}); // the chat works without it
  }, [conversationId]);
  useEffect(() => {
    if (current.current !== conversationId) {
      current.current = conversationId;
      setData(null);
    }
    reload();
  }, [conversationId, refreshKey, reload]);
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId === conversationId && reload();
    window.addEventListener(AI_ROBOT_EVENT, on);
    return () => window.removeEventListener(AI_ROBOT_EVENT, on);
  }, [conversationId, reload]);
  const dueAt = data?.status.dueAt;
  useEffect(() => {
    if (!dueAt) return;
    const t = setTimeout(reload, Math.max(0, new Date(dueAt).getTime() - Date.now()) + 3000);
    return () => clearTimeout(t);
  }, [dueAt, reload]);
  return { data, reload };
}

// The tab shows while the robot can work in this workspace, or once it has done something in this chat
export const showRobotTab = (data: AiRobotChat) => !!data && (data.status.state !== 'off' || data.runs.length > 0);

const STATE_STYLE: Record<AiRobotStatus['state'], { text: string; chip: string }> = {
  off: { text: 'Off', chip: 'bg-surface-strong text-muted' },
  waiting: { text: 'Waiting', chip: 'bg-primary-soft text-primary' },
  active: { text: 'Active', chip: 'bg-success-soft text-success' },
  stopped: { text: 'Stopped', chip: 'bg-surface-strong text-body' },
  handover: { text: 'Needs human', chip: 'bg-warning-soft text-warning' },
};

function Countdown({ dueAt }: { dueAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono tabular-nums">{countdown(dueAt, now)}</span>;
}

export function AiRobotPanel({
  data,
  conversationId,
  onChanged,
  replyBlocked,
  onUseReply,
}: {
  data: AiRobotChat;
  conversationId: string;
  onChanged: () => void;
  // Why a reply can't be sent now (e.g. the 24-hour window closed); null when it can
  replyBlocked: string | null;
  onUseReply: (text: string) => void;
}) {
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openRun, setOpenRun] = useState<string | null>(null);
  useEffect(() => {
    setConfirmStop(false);
    setError('');
    setOpenRun(null);
  }, [conversationId]);

  if (!data) return <div className="h-28 animate-pulse rounded-lg bg-surface-muted" aria-busy="true" />;
  const { status, runs } = data;
  const style = STATE_STYLE[status.state];
  const canStop = status.state === 'waiting' || status.state === 'active';
  // In draft mode: the newest decision is a draft nobody has used yet
  const draft = runs[0]?.action === 'draft' && runs[0].draft ? runs[0] : null;

  const stop = async () => {
    setBusy(true);
    setError('');
    try {
      await stopAiRobot(conversationId);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmStop(false);
    }
  };

  return (
    <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-line bg-surface p-3 text-[13px]" aria-label="AI Robot">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${style.chip}`}>{style.text}</span>
        {status.mode === 'draft' && status.state !== 'off' && (
          <span className="rounded-full border border-warning-border px-2 py-0.5 text-[11px] font-semibold text-warning" title="Settings → AI Robot: replies are written here, nothing is sent">
            Draft mode
          </span>
        )}
        <span className="min-w-0 flex-1 text-body">
          {status.dueAt && (status.state === 'waiting' || status.state === 'active') ? (
            <>
              Replies in <Countdown dueAt={status.dueAt} /> if nobody from the team does
            </>
          ) : (
            status.label
          )}
        </span>
        {canStop && (
          <button
            type="button"
            onClick={() => setConfirmStop(true)}
            disabled={busy}
            className="rounded-lg border border-danger-border px-3 py-1 text-[12px] font-semibold text-danger hover:bg-danger-soft disabled:opacity-50"
          >
            Stop robot
          </button>
        )}
      </div>
      {error && <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      {draft && (
        <div className="mt-3 rounded-lg border border-primary-soft-border bg-primary-subtle p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-primary">Draft reply (not sent)</p>
          <p className="mt-1.5 whitespace-pre-wrap text-ink">{draft.draft}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onUseReply(draft.draft!)}
              disabled={!!replyBlocked}
              title={replyBlocked ?? undefined}
              className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
            >
              Use this reply
            </button>
            {replyBlocked && <span className="text-[12px] text-muted">{replyBlocked}</span>}
          </div>
        </div>
      )}

      <p className="mb-1.5 mt-3 text-[11px] font-bold uppercase tracking-wide text-muted">History in this chat</p>
      {runs.length === 0 ? (
        <p className="text-muted">The robot hasn&apos;t done anything in this chat yet.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {runs.map((r) => {
            const open = openRun === r.id;
            const more = r.tools.length > 0 || (!!r.draft && r !== draft);
            return (
              <li key={r.id} className="py-1.5">
                <button type="button" onClick={() => more && setOpenRun(open ? null : r.id)} aria-expanded={more ? open : undefined} className={`flex w-full items-baseline gap-2 text-left ${more ? 'cursor-pointer' : 'cursor-default'}`}>
                  <span className={`shrink-0 font-semibold ${r.action === 'handover' || r.action === 'order' ? 'text-warning' : r.action === 'failed' || r.action === 'blocked' ? 'text-danger' : 'text-ink'}`}>{RUN_LABELS[r.action] ?? r.action}</span>
                  <span className="min-w-0 flex-1 truncate text-body-soft" title={r.reason ?? undefined}>
                    {r.reason ?? ''}
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">{formatDateTime(r.createdAt)}</span>
                  {more && <span className="shrink-0 text-[11px] text-primary">{open ? 'Less' : 'More'}</span>}
                </button>
                {open && (
                  <div className="mt-1 space-y-1 pl-2 text-[12px] text-body-soft">
                    {r.reason && <p className="whitespace-pre-wrap">{r.reason}</p>}
                    {r.tools.map((t, i) => (
                      <p key={i}>• {toolText(t)}</p>
                    ))}
                    {r.draft && r !== draft && <p className="whitespace-pre-wrap rounded bg-surface-muted px-2 py-1 text-body">{r.draft}</p>}
                    {r.confidence != null && <p>Confidence {Math.round(r.confidence * 100)}%</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {confirmStop && (
        <ConfirmDialog
          title="Stop the robot in this chat?"
          body="It won't reply in this chat again until the chat is closed and reopened. Other chats aren't affected."
          yes="Stop robot"
          no="Cancel"
          danger
          busy={busy}
          error={error || undefined}
          onYes={stop}
          onNo={() => setConfirmStop(false)}
        />
      )}
    </div>
  );
}
