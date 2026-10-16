"use client";

import { useEffect, useRef, useState } from "react";
import {
  type ContactOption,
  createLeadStage,
  deleteLeadStage,
  fetchContactFieldOptions,
  fetchLeadStageCounts,
  reorderLeadStages,
  setDefaultLeadStage,
  updateLeadStage,
} from "@/lib/contacts";
import { isAdminRole } from "@/lib/roles";
import { showToast } from "@/lib/toasts";
import { AppShell } from "../../AppShell";
import { inputClass } from "../../AuthShell";
import { useStagesChanged } from "../../inbox/StageMenu";
import { SettingsShell } from "../SettingsShell";
import { TableSkeleton } from '../Skeleton';

// Settings → Contacts and data → Customer lifecycle: the workspace's lead stages, managed by admins. Progressing
// stages are the journey in order (the chat's › button moves a contact to the next one); Lost stages end it. Each
// stage: colour, name (edited in place), drag to reorder or into the other group, ⋮ to make it the default (new
// contacts start on it), move it to the other group, or delete it (its contacts move to a stage you choose).
// Everything is saved at once, and every stage menu, pill and profile in the app follows.
export default function LifecyclePage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell
          me={me}
          section="Contacts and data"
          title="Customer lifecycle"
        >
          <Lifecycle isAdmin={isAdminRole(me.role)} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

const MAX_STAGES = 20; // the server's limit (it refuses more)
// Colour choices for a stage (any other colour can be picked with "Custom")
const PALETTE = [
  "#f59e0b",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#d946ef",
  "#ec4899",
  "#64748b",
];

type Stage = ContactOption & { id: string; color: string };

function Lifecycle({ isAdmin }: { isAdmin: boolean }) {
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [counts, setCounts] = useState<Map<string | null, number>>(new Map());
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Stage | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    over: string | null;
    group: "progressing" | "lost" | null;
  } | null>(null);

  const loadCounts = () =>
    fetchLeadStageCounts()
      .then((rows) => setCounts(new Map(rows.map((r) => [r.stage, r.count]))))
      .catch(() => {});
  const load = (fresh: boolean) =>
    fetchContactFieldOptions(fresh)
      .then((o) => setStages(o.leadStages as Stage[]))
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load(false);
    loadCounts();
  }, []);
  useStagesChanged(() => {
    load(true);
    loadCounts();
  });

  // Every change goes to the server, which answers with the stages as they now are
  async function run(action: () => Promise<ContactOption[]>, done?: string) {
    setError("");
    try {
      setStages((await action()) as Stage[]);
      if (done)
        showToast(`stage:${Date.now()}`, "", done, "Customer lifecycle");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  if (!stages)
    return error ? (
      <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
        {error}
      </p>
    ) : (
      <TableSkeleton rows={6} className="mt-[140px]" />
    );
  const progressing = stages.filter((s) => !s.closed);
  const lost = stages.filter((s) => s.closed);
  const full = stages.length >= MAX_STAGES;

  // Drop `id` before `beforeId` in `group` (null = at the end)
  function drop(group: "progressing" | "lost", beforeId: string | null) {
    if (!drag) return;
    const id = drag.id;
    setDrag(null);
    const p = progressing.map((s) => s.id).filter((x) => x !== id);
    const l = lost.map((s) => s.id).filter((x) => x !== id);
    const list = group === "progressing" ? p : l;
    const at = beforeId ? list.indexOf(beforeId) : -1;
    list.splice(at < 0 ? list.length : at, 0, id);
    const before = [
      ...progressing.map((s) => s.id),
      "|",
      ...lost.map((s) => s.id),
    ].join();
    if ([...p, "|", ...l].join() === before) return;
    run(() => reorderLeadStages(p, l));
  }
  function moveToOther(stage: Stage) {
    const p = progressing.map((s) => s.id).filter((x) => x !== stage.id);
    const l = lost.map((s) => s.id).filter((x) => x !== stage.id);
    if (stage.closed) p.push(stage.id);
    else l.push(stage.id);
    run(
      () => reorderLeadStages(p, l),
      `“${stage.label}” moved to ${stage.closed ? "Progressing" : "Lost"} stages.`,
    );
  }

  const group = (kind: "progressing" | "lost", list: Stage[]) => (
    <StageGroup
      kind={kind}
      stages={list}
      all={stages}
      counts={counts}
      isAdmin={isAdmin}
      full={full}
      drag={drag}
      setDrag={setDrag}
      onDrop={(beforeId) => drop(kind, beforeId)}
      onRename={(s, label) =>
        run(() => updateLeadStage(s.id, { label }), `Renamed to “${label}”.`)
      }
      onColor={(s, color) => run(() => updateLeadStage(s.id, { color }))}
      onCreate={(label, color) =>
        run(
          () => createLeadStage({ label, color, lost: kind === "lost" }),
          `Stage “${label}” created.`,
        )
      }
      onDefault={(s) =>
        run(
          () => setDefaultLeadStage(s.id),
          `New contacts now start on “${s.label}”.`,
        )
      }
      onMove={moveToOther}
      onDelete={setDeleting}
    />
  );

  return (
    <div className="max-w-6xl">
      <h2 className="text-xl font-bold text-ink">
        Manage customer lifecycle stages
      </h2>
      <p className="mt-2 max-w-4xl text-[13px] leading-relaxed text-body-soft">
        Create and organize lifecycle stages to track each contact&apos;s
        progress through your customer lifecycle, from initial engagement to
        conversion or resolution. Set a contact&apos;s stage from the chat
        header (› moves them to the next progressing stage) or their profile.
      </p>
      <p className="mt-4 text-[13px] text-body">
        You can create up to {MAX_STAGES} lifecycle stages in total (
        {stages.length} used).
        {!isAdmin && (
          <span className="text-muted"> Only admins can change them.</span>
        )}
      </p>
      {error && (
        <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="mt-5 grid items-start gap-6 lg:grid-cols-2">
        {group("progressing", progressing)}
        {group("lost", lost)}
      </div>
      {deleting && (
        <DeleteStage
          stage={deleting}
          others={stages.filter((s) => s.id !== deleting.id)}
          count={counts.get(deleting.value) ?? 0}
          onClose={() => setDeleting(null)}
          onDeleted={(next, moved) => {
            setStages(next as Stage[]);
            setDeleting(null);
            loadCounts();
            showToast(
              `stage:${Date.now()}`,
              "",
              `“${deleting.label}” deleted${moved ? `; ${moved} contact${moved === 1 ? "" : "s"} moved` : ""}.`,
              "Customer lifecycle",
            );
          }}
        />
      )}
    </div>
  );
}

const COPY = {
  progressing: {
    title: "Progressing stages",
    text: "Stages for contacts that are currently engaging or moving forward in your customer lifecycle",
    head: "bg-success-soft",
    icon: "text-success",
    path: "M3 17l6-6 4 4 8-8M15 7h6v6",
  },
  lost: {
    title: "Lost stages",
    text: "Stages for contacts that are no longer progressing in your customer lifecycle, such as when a conversation, deal, or case has ended",
    head: "bg-danger-soft",
    icon: "text-danger",
    path: "M3 7l6 6 4-4 8 8M15 17h6v-6",
  },
};

function StageGroup({
  kind,
  stages,
  all,
  counts,
  isAdmin,
  full,
  drag,
  setDrag,
  onDrop,
  onRename,
  onColor,
  onCreate,
  onDefault,
  onMove,
  onDelete,
}: {
  kind: "progressing" | "lost";
  stages: Stage[];
  all: Stage[];
  counts: Map<string | null, number>;
  isAdmin: boolean;
  full: boolean;
  drag: {
    id: string;
    over: string | null;
    group: "progressing" | "lost" | null;
  } | null;
  setDrag: (
    d: {
      id: string;
      over: string | null;
      group: "progressing" | "lost" | null;
    } | null,
  ) => void;
  onDrop: (beforeId: string | null) => void;
  onRename: (s: Stage, label: string) => Promise<boolean>;
  onColor: (s: Stage, color: string) => Promise<boolean>;
  onCreate: (label: string, color: string) => Promise<boolean>;
  onDefault: (s: Stage) => void;
  onMove: (s: Stage) => void;
  onDelete: (s: Stage) => void;
}) {
  const c = COPY[kind];
  const [adding, setAdding] = useState(false);
  // A colour not used yet, for a new stage
  const freshColor =
    PALETTE.find((p) => !all.some((s) => s.color.toLowerCase() === p)) ??
    PALETTE[0];
  const dropping = drag && drag.group === kind;
  return (
    <section
      aria-label={c.title}
      className={`overflow-hidden rounded-xl border bg-surface ${dropping && !drag.over ? "border-primary" : "border-line"}`}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        if (drag.group !== kind || drag.over)
          setDrag({ ...drag, group: kind, over: null });
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(null);
      }}
    >
      <div className={`px-6 py-5 ${c.head}`}>
        <h3 className="flex items-center gap-3 text-[17px] font-bold text-ink">
          <svg
            className={`h-5 w-5 ${c.icon}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={c.path} />
          </svg>
          {c.title}
        </h3>
        <p className="mt-2 text-[13px] text-body">{c.text}</p>
      </div>
      <div className="p-5">
        <ul className="divide-y divide-line-soft rounded-xl border border-line bg-surface">
          {stages.map((s) => (
            <StageRow
              key={s.id}
              stage={s}
              all={all}
              count={counts.get(s.value) ?? 0}
              isAdmin={isAdmin}
              kind={kind}
              dragging={drag?.id === s.id}
              dropBefore={!!drag && drag.over === s.id && drag.id !== s.id}
              onDragStart={() => setDrag({ id: s.id, over: null, group: kind })}
              onDragOver={() =>
                drag &&
                drag.over !== s.id &&
                setDrag({ ...drag, group: kind, over: s.id })
              }
              onDrop={() => onDrop(s.id)}
              onDragEnd={() => setDrag(null)}
              onRename={(label) => onRename(s, label)}
              onColor={(color) => onColor(s, color)}
              onDefault={() => onDefault(s)}
              onMove={() => onMove(s)}
              onDelete={() => onDelete(s)}
            />
          ))}
          {!stages.length && !adding && (
            <li className="px-5 py-6 text-center text-xs text-faint">
              {dropping ? "Drop here" : "No stages yet"}
            </li>
          )}
          {adding && (
            <NewStage
              color={freshColor}
              onCancel={() => setAdding(false)}
              onCreate={async (label, color) =>
                (await onCreate(label, color)) && setAdding(false)
              }
            />
          )}
        </ul>
        {isAdmin && (
          <button
            type="button"
            disabled={full || adding}
            onClick={() => setAdding(true)}
            title={
              full ? `You can create up to ${MAX_STAGES} stages` : undefined
            }
            aria-label={`Create a ${kind} stage`}
            className="mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] font-semibold text-primary transition hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="text-lg leading-none">+</span> Create
          </button>
        )}
      </div>
    </section>
  );
}

const handleIcon = (
  <svg
    className="h-4 w-4"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    {[6, 12, 18].flatMap((y) =>
      [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />),
    )}
  </svg>
);

function StageRow({
  stage,
  all,
  count,
  isAdmin,
  kind,
  dragging,
  dropBefore,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onRename,
  onColor,
  onDefault,
  onMove,
  onDelete,
}: {
  stage: Stage;
  all: Stage[];
  count: number;
  isAdmin: boolean;
  kind: "progressing" | "lost";
  dragging: boolean;
  dropBefore: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onRename: (label: string) => Promise<boolean>;
  onColor: (color: string) => Promise<boolean>;
  onDefault: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(stage.label);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setLabel(stage.label), [stage.label]);
  useEffect(() => {
    if (!menu) return;
    const onPointer = (e: MouseEvent) =>
      !menuRef.current?.contains(e.target as Node) && setMenu(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  async function saveLabel() {
    const next = label.trim();
    if (next === stage.label) return setLabel(stage.label);
    if (!next || !(await onRename(next))) setLabel(stage.label);
  }
  const otherProgressing = all.filter(
    (s) => !s.closed && s.id !== stage.id,
  ).length;
  const item =
    "block w-full px-3.5 py-2 text-left text-[13px] text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent";

  return (
    <li
      data-stage={stage.value}
      draggable={isAdmin}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", stage.id);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={`flex items-center gap-3 px-4 py-3 ${dragging ? "opacity-40" : ""} ${dropBefore ? "shadow-[inset_0_2px_0_0_var(--color-primary)]" : ""}`}
    >
      <span
        className={`shrink-0 ${isAdmin ? "cursor-grab text-faint active:cursor-grabbing" : "invisible"}`}
        title="Drag to reorder"
      >
        {handleIcon}
      </span>
      <ColorPicker
        color={stage.color}
        label={stage.label}
        disabled={!isAdmin}
        onChange={onColor}
      />
      {/* Name, with the number of contacts at the stage inside the box on the right */}
      <div className="relative min-w-0 flex-1">
        <input
          value={label}
          disabled={!isAdmin}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={saveLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setLabel(stage.label);
              setTimeout(() =>
                (document.activeElement as HTMLElement | null)?.blur(),
              );
            }
          }}
          maxLength={40}
          aria-label={`Stage name: ${stage.label}`}
          className={`${inputClass} h-10 !rounded-lg !py-0 !pr-24 text-[13px] disabled:cursor-default disabled:bg-surface`}
        />
        <span
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-faint"
          title={`${count} contact${count === 1 ? "" : "s"} at this stage`}
        >
          {count} {count === 1 ? "contact" : "contacts"}
        </span>
      </div>
      {/* One fixed slot on the right (so every name box is the same width): DEFAULT, or the ⋮ menu */}
      <div className="flex w-20 shrink-0 items-center justify-center">
        {stage.isDefault ? (
          <span
            className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-primary"
            title="New contacts start on this stage"
          >
            Default
          </span>
        ) : (
          isAdmin && (
            <div ref={menuRef} className="relative">
              <button
                type="button"
                onClick={() => setMenu((m) => !m)}
                aria-label={`More options for ${stage.label}`}
                aria-haspopup="menu"
                aria-expanded={menu}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-body-soft hover:bg-surface-muted"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="5" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="12" cy="19" r="1.8" />
                </svg>
              </button>
              {menu && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl"
                >
                  {kind === "progressing" && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!!stage.isDefault}
                      onClick={() => (setMenu(false), onDefault())}
                      className={item}
                    >
                      {stage.isDefault ? "Default stage" : "Set as default"}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={
                      !!stage.isDefault ||
                      (kind === "progressing" && !otherProgressing)
                    }
                    title={
                      stage.isDefault
                        ? "The default stage must be a progressing stage"
                        : undefined
                    }
                    onClick={() => (setMenu(false), onMove())}
                    className={item}
                  >
                    Move to {kind === "progressing" ? "Lost" : "Progressing"}{" "}
                    stages
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={
                      !!stage.isDefault ||
                      (kind === "progressing" && !otherProgressing)
                    }
                    title={
                      stage.isDefault
                        ? "Choose another default stage first"
                        : undefined
                    }
                    onClick={() => (setMenu(false), onDelete())}
                    className={`${item} !text-danger disabled:!text-faint`}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          )
        )}
      </div>
    </li>
  );
}

// The colour square: a palette, plus any colour with "Custom"
function ColorPicker({
  color,
  label,
  disabled,
  onChange,
}: {
  color: string;
  label: string;
  disabled?: boolean;
  onChange: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) =>
      !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (c: string) => {
    setOpen(false);
    if (c.toLowerCase() !== color.toLowerCase()) onChange(c.toLowerCase());
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Colour of ${label}`}
        aria-expanded={open}
        className="block h-10 w-10 rounded-lg shadow-inner transition disabled:cursor-default enabled:hover:ring-2 enabled:hover:ring-line"
        style={{ backgroundColor: color }}
      />
      {open && (
        <div
          role="dialog"
          aria-label={`Choose a colour for ${label}`}
          className="absolute left-0 top-full z-30 mt-2 w-56 rounded-xl border border-line bg-surface p-3 shadow-xl"
        >
          <div className="grid grid-cols-6 gap-2">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => pick(c)}
                aria-label={c}
                aria-pressed={c === color.toLowerCase()}
                className={`h-7 w-7 rounded-md ${c === color.toLowerCase() ? "ring-2 ring-ink ring-offset-2 ring-offset-surface" : ""}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-body">
            <input
              type="color"
              defaultValue={color}
              onChange={(e) => pick(e.target.value)}
              className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent"
            />
            Custom colour
          </label>
        </div>
      )}
    </div>
  );
}

function NewStage({
  color: initial,
  onCreate,
  onCancel,
}: {
  color: string;
  onCreate: (label: string, color: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function create() {
    if (!label.trim()) return;
    setBusy(true);
    await onCreate(label.trim(), color);
    setBusy(false);
  }
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="invisible shrink-0">{handleIcon}</span>
      <ColorPicker color={color} label="the new stage" onChange={setColor} />
      <input
        autoFocus
        value={label}
        disabled={busy}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") create();
          if (e.key === "Escape") onCancel();
        }}
        maxLength={40}
        placeholder="Stage name"
        aria-label="New stage name"
        className={`${inputClass} h-10 min-w-0 flex-1 !rounded-lg !py-0 text-[13px]`}
      />
      <button
        type="button"
        disabled={busy || !label.trim()}
        onClick={create}
        className="shrink-0 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-on-primary disabled:opacity-50"
      >
        {busy ? "Saving…" : "Add"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className="shrink-0 rounded-lg px-2 py-2 text-xs text-body-soft hover:bg-surface-muted"
      >
        Cancel
      </button>
    </li>
  );
}

// Delete: the stage's contacts move to another stage (or to no stage) first
function DeleteStage({
  stage,
  others,
  count,
  onClose,
  onDeleted,
}: {
  stage: Stage;
  others: Stage[];
  count: number;
  onClose: () => void;
  onDeleted: (stages: ContactOption[], moved: number) => void;
}) {
  const [moveTo, setMoveTo] = useState(
    others.find((s) => s.isDefault)?.value ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  async function remove() {
    setBusy(true);
    setError("");
    try {
      const r = await deleteLeadStage(
        stage.id,
        stage.value,
        count ? moveTo || null : null,
      );
      onDeleted(r.stages, r.moved);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-stage-title"
        className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl"
      >
        <h2 id="delete-stage-title" className="text-lg font-bold text-ink">
          Delete “{stage.label}”?
        </h2>
        {count ? (
          <>
            <p className="mt-2 text-[13px] text-body-soft">
              {count} contact{count === 1 ? " is" : "s are"} at this stage. Move{" "}
              {count === 1 ? "it" : "them"} to:
            </p>
            <select
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              aria-label="Move its contacts to"
              className={`${inputClass} mt-3 cursor-pointer`}
            >
              {others.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                  {s.closed ? " (lost)" : ""}
                </option>
              ))}
              <option value="">No stage</option>
            </select>
          </>
        ) : (
          <p className="mt-2 text-[13px] text-body-soft">
            No contacts are at this stage.
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-[13px] text-body-soft hover:bg-surface-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="rounded-lg bg-danger px-4 py-2 text-[13px] font-semibold text-on-primary hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
