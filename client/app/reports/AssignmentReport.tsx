// 'use client';

// import Link from 'next/link';
// import { useRouter } from 'next/navigation';
// import { useCallback, useEffect, useMemo, useState } from 'react';
// import {
//   type AssignmentRecord,
//   dayEndIso,
//   dayStartIso,
//   downloadAssignmentReportCsv,
//   fetchAssignmentReport,
// } from '@/lib/reports';
// import { revalidateOnReturn } from '@/lib/revalidate';
// import { isAdminRole } from '@/lib/roles';
// import { dayLabel, formatDateTime } from '@/lib/time';
// import { type Preset, PRESETS, presetRange } from '@/lib/dateRange';
// import { ContactAvatar } from '../inbox/avatar';
// import { AppShell, type Me } from '../AppShell';
// import { inputClass } from '../AuthShell';

// // Reports: owners and admins only (the server refuses the report to everyone else).
// // Supervisors and agents are sent back to the Inbox.
// function PartyPill({ party, fallback = 'Unassigned' }: { party: { name: string } | null; fallback?: string }) {
//   if (!party?.name) {
//     return (
//       <span className="inline-flex items-center rounded-md border border-line bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-muted">
//         {fallback}
//       </span>
//     );
//   }
//   return (
//     <span className="inline-flex items-center gap-1 rounded-md border border-primary-soft-border bg-primary-subtle px-2 py-0.5 text-[11px] font-semibold text-primary">
//       <span className="h-1.5 w-1.5 rounded-full bg-accent" />
//       <span className="truncate max-w-[120px]">{party.name}</span>
//     </span>
//   );
// }

// // Assignment report: audit log of every assignment, transfer and unassignment with reasons and actors
// export function AssignmentReport() {
//   const initialRange = presetRange('last30')!; // the last 30 Dubai days

//   const [preset, setPreset] = useState<Preset>('last30');
//   const [from, setFrom] = useState(initialRange.from);
//   const [to, setTo] = useState(initialRange.to);
//   const [rows, setRows] = useState<AssignmentRecord[] | null>(null);
//   const [error, setError] = useState('');
//   const [busy, setBusy] = useState<'load' | 'export' | null>(null);

//   // Filters & Search
//   const [searchQuery, setSearchQuery] = useState('');
//   const [filterType, setFilterType] = useState<'all' | 'new' | 'reassign' | 'unassigned' | 'has_reason'>('all');
//   const [selectedAssignee, setSelectedAssignee] = useState<string>('');

//   // Pagination
//   const [page, setPage] = useState(1);
//   const pageSize = 20;

//   const load = useCallback(async () => {
//     setBusy('load');
//     setError('');
//     try {
//       const data = await fetchAssignmentReport({
//         from: dayStartIso(from),
//         to: dayEndIso(to),
//       });
//       setRows(data);
//     } catch (err) {
//       setError((err as Error).message);
//     } finally {
//       setBusy(null);
//     }
//   }, [from, to]);

//   useEffect(() => {
//     load();
//     return revalidateOnReturn(load);
//   }, [load]);

//   // When date preset changes
//   function choosePreset(p: Preset) {
//     setPreset(p);
//     if (p === 'custom') return;
//     const r = presetRange(p);
//     if (r) {
//       setFrom(r.from);
//       setTo(r.to);
//       setPage(1);
//     }
//   }

//   function handleCustomFrom(val: string) {
//     setPreset('custom');
//     setFrom(val);
//     setPage(1);
//   }

//   function handleCustomTo(val: string) {
//     setPreset('custom');
//     setTo(val);
//     setPage(1);
//   }

//   async function exportCsv() {
//     setBusy('export');
//     setError('');
//     try {
//       await downloadAssignmentReportCsv({ from: dayStartIso(from), to: dayEndIso(to) });
//     } catch (err) {
//       setError((err as Error).message);
//     } finally {
//       setBusy(null);
//     }
//   }

//   // Summary Metrics
//   const stats = useMemo(() => {
//     if (!rows) return { total: 0, newAssigned: 0, reassigned: 0, unassigned: 0, withReason: 0, reasonRate: 0 };
//     const total = rows.length;
//     const newAssigned = rows.filter((r) => !r.previousAssignee && r.newAssignee).length;
//     const reassigned = rows.filter((r) => r.previousAssignee && r.newAssignee).length;
//     const unassigned = rows.filter((r) => !r.newAssignee).length;
//     const withReason = rows.filter((r) => !!r.reason && r.reason.trim().length > 0).length;
//     const reasonRate = total > 0 ? Math.round((withReason / total) * 100) : 0;
//     return { total, newAssigned, reassigned, unassigned, withReason, reasonRate };
//   }, [rows]);

//   // Unique assignees for dropdown filter
//   const assigneesList = useMemo(() => {
//     if (!rows) return [];
//     const set = new Set<string>();
//     for (const r of rows) {
//       if (r.newAssignee?.name) set.add(r.newAssignee.name);
//       if (r.previousAssignee?.name) set.add(r.previousAssignee.name);
//     }
//     return Array.from(set).sort((a, b) => a.localeCompare(b));
//   }, [rows]);

//   // Filtered rows
//   const filteredRows = useMemo(() => {
//     if (!rows) return [];
//     return rows.filter((r) => {
//       // 1. Filter Type
//       if (filterType === 'new' && (r.previousAssignee || !r.newAssignee)) return false;
//       if (filterType === 'reassign' && (!r.previousAssignee || !r.newAssignee)) return false;
//       if (filterType === 'unassigned' && r.newAssignee) return false;
//       if (filterType === 'has_reason' && (!r.reason || !r.reason.trim())) return false;

//       // 2. Assignee dropdown
//       if (selectedAssignee) {
//         const match = r.newAssignee?.name === selectedAssignee || r.previousAssignee?.name === selectedAssignee;
//         if (!match) return false;
//       }

//       // 3. Search query
//       if (searchQuery.trim()) {
//         const q = searchQuery.toLowerCase().trim();
//         const contact = (r.contactName ?? '').toLowerCase();
//         const waId = (r.contactWaId ?? '').toLowerCase();
//         const prev = (r.previousAssignee?.name ?? 'unassigned').toLowerCase();
//         const next = (r.newAssignee?.name ?? 'unassigned').toLowerCase();
//         const by = (r.assignedBy?.name ?? 'system').toLowerCase();
//         const reason = (r.reason ?? '').toLowerCase();
//         const convId = (r.conversationId ?? '').toLowerCase();
//         return (
//           contact.includes(q) ||
//           waId.includes(q) ||
//           prev.includes(q) ||
//           next.includes(q) ||
//           by.includes(q) ||
//           reason.includes(q) ||
//           convId.includes(q)
//         );
//       }
//       return true;
//     });
//   }, [rows, filterType, selectedAssignee, searchQuery]);

//   // Reset page when filter or search changes
//   useEffect(() => {
//     setPage(1);
//   }, [searchQuery, filterType, selectedAssignee]);

//   // Pagination calculation
//   const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
//   const currentPage = Math.min(page, totalPages);
//   const paginatedRows = useMemo(() => {
//     const start = (currentPage - 1) * pageSize;
//     return filteredRows.slice(start, start + pageSize);
//   }, [filteredRows, currentPage, pageSize]);

//   return (
//     <div className="space-y-6">
//       {/* 1. Header & Actions Card */}
//       <section className="rounded-2xl border border-line bg-surface p-5 shadow-xs sm:p-6">
//         <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
//           <div>
//             <div className="flex items-center gap-2">
//               <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-soft text-primary">
//                 <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
//                   <path d="M3 3v18h18" />
//                   <path d="M7 15l4-4 4 4 5-6" />
//                 </svg>
//               </span>
//               <h2 className="text-base font-bold text-ink">Assignment & Activity Report</h2>
//             </div>
//             <p className="mt-1 text-xs text-muted">
//               Audit chat distributions, transfers between agents, queue releases, and recorded reasons.
//             </p>
//           </div>

//           <div className="flex items-center gap-2.5">
//             <button
//               type="button"
//               disabled={busy !== null}
//               onClick={load}
//               title="Refresh report data"
//               className="flex items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-2 text-xs font-semibold text-body hover:bg-surface-strong transition disabled:opacity-50"
//             >
//               <svg className={`h-3.5 w-3.5 ${busy === 'load' ? 'animate-spin text-primary' : 'text-muted'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
//                 <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
//                 <path d="M3 3v5h5" />
//                 <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
//                 <path d="M16 21h5v-5" />
//               </svg>
//               <span>{busy === 'load' ? 'Updating…' : 'Refresh'}</span>
//             </button>

//             <button
//               type="button"
//               disabled={busy !== null || !rows?.length}
//               onClick={exportCsv}
//               className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover shadow-2xs transition disabled:opacity-50"
//             >
//               <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
//                 <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
//                 <polyline points="7 10 12 15 17 10" />
//                 <line x1="12" y1="15" x2="12" y2="3" />
//               </svg>
//               <span>{busy === 'export' ? 'Exporting…' : 'Export CSV'}</span>
//             </button>
//           </div>
//         </div>

//         {/* Date Presets and Date Pickers */}
//         <div className="mt-5 border-t border-line-soft pt-4">
//           <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
//             {/* Presets */}
//             <div className="flex flex-wrap items-center gap-1.5">
//               <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Range:</span>
//               {PRESETS.map((p) => {
//                 const active = preset === p.key;
//                 return (
//                   <button
//                     key={p.key}
//                     type="button"
//                     aria-pressed={active}
//                     onClick={() => choosePreset(p.key)}
//                     className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
//                       active
//                         ? 'border-primary/40 bg-primary-subtle text-primary font-semibold'
//                         : 'border-transparent bg-surface-muted text-body-soft hover:bg-surface-strong'
//                     }`}
//                   >
//                     {p.label}
//                   </button>
//                 );
//               })}
//             </div>

//             {/* From / To Date Pickers */}
//             <div className="flex items-center gap-2">
//               <label className="flex items-center gap-1.5 text-xs text-muted font-medium">
//                 <span>From</span>
//                 <input
//                   type="date"
//                   value={from}
//                   max={to}
//                   onChange={(e) => handleCustomFrom(e.target.value)}
//                   className={`${inputClass} !py-1 !px-2.5 !text-xs w-36`}
//                 />
//               </label>
//               <span className="text-faint">→</span>
//               <label className="flex items-center gap-1.5 text-xs text-muted font-medium">
//                 <span>To</span>
//                 <input
//                   type="date"
//                   value={to}
//                   min={from}
//                   onChange={(e) => handleCustomTo(e.target.value)}
//                   className={`${inputClass} !py-1 !px-2.5 !text-xs w-36`}
//                 />
//               </label>
//             </div>
//           </div>
//         </div>
//       </section>

//       {/* 2. KPI Summary Metrics Overview */}
//       <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
//         <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
//           <p className="text-[11px] font-medium text-muted">Total Events</p>
//           <p className="mt-1 text-2xl font-bold tracking-tight text-ink tabular-nums">{stats.total}</p>
//           <p className="mt-0.5 text-[10px] text-faint">All assignment changes</p>
//         </div>

//         <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
//           <p className="text-[11px] font-medium text-muted">Initial Claims</p>
//           <p className="mt-1 text-2xl font-bold tracking-tight text-primary tabular-nums">{stats.newAssigned}</p>
//           <p className="mt-0.5 text-[10px] text-faint">Assigned from queue</p>
//         </div>

//         <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
//           <p className="text-[11px] font-medium text-muted">Reassignments</p>
//           <p className="mt-1 text-2xl font-bold tracking-tight text-ink tabular-nums">{stats.reassigned}</p>
//           <p className="mt-0.5 text-[10px] text-faint">Transferred to agent</p>
//         </div>

//         <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
//           <p className="text-[11px] font-medium text-muted">Released / Unassigned</p>
//           <p className="mt-1 text-2xl font-bold tracking-tight text-muted tabular-nums">{stats.unassigned}</p>
//           <p className="mt-0.5 text-[10px] text-faint">Returned to unassigned</p>
//         </div>

//         <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs col-span-2 sm:col-span-1">
//           <div className="flex items-center justify-between">
//             <p className="text-[11px] font-medium text-muted">Reasons Logged</p>
//             <span className="text-[11px] font-semibold text-primary">{stats.reasonRate}%</span>
//           </div>
//           <p className="mt-1 text-2xl font-bold tracking-tight text-ink tabular-nums">{stats.withReason}</p>
//           <p className="mt-0.5 text-[10px] text-faint">Includes typed justification</p>
//         </div>
//       </section>

//       {/* 3. Search & Filter Bar */}
//       <section className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
//         <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
//           {/* Search Box */}
//           <div className="relative min-w-0 flex-1 max-w-md">
//             <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-faint">
//               <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
//                 <circle cx="11" cy="11" r="8" />
//                 <path d="m21 21-4.3-4.3" />
//               </svg>
//             </span>
//             <input
//               type="text"
//               value={searchQuery}
//               onChange={(e) => setSearchQuery(e.target.value)}
//               placeholder="Search customer, phone, assignee, reason..."
//               className={`${inputClass} !py-2 !pl-9 !pr-8 text-xs`}
//             />
//             {searchQuery && (
//               <button
//                 type="button"
//                 onClick={() => setSearchQuery('')}
//                 className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-faint hover:text-body"
//               >
//                 ✕
//               </button>
//             )}
//           </div>

//           <div className="flex flex-wrap items-center gap-2.5">
//             {/* Quick Status Filters */}
//             <div className="flex items-center gap-1">
//               {(
//                 [
//                   ['all', `All (${rows ? rows.length : 0})`],
//                   ['reassign', `Reassigned (${stats.reassigned})`],
//                   ['new', `Claimed (${stats.newAssigned})`],
//                   ['unassigned', `Unassigned (${stats.unassigned})`],
//                   ['has_reason', `With Reason (${stats.withReason})`],
//                 ] as const
//               ).map(([val, label]) => {
//                 const active = filterType === val;
//                 return (
//                   <button
//                     key={val}
//                     type="button"
//                     aria-pressed={active}
//                     onClick={() => setFilterType(val)}
//                     className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
//                       active
//                         ? 'border-primary/40 bg-primary-subtle text-primary font-semibold'
//                         : 'border-line bg-surface text-body-soft hover:bg-surface-strong'
//                     }`}
//                   >
//                     {label}
//                   </button>
//                 );
//               })}
//             </div>

//             {/* Assignee Filter Dropdown */}
//             {assigneesList.length > 0 && (
//               <select
//                 aria-label="Filter by Assignee"
//                 value={selectedAssignee}
//                 onChange={(e) => setSelectedAssignee(e.target.value)}
//                 className="rounded-xl border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-body outline-none hover:bg-surface-strong"
//               >
//                 <option value="">All Assignees</option>
//                 {assigneesList.map((a) => (
//                   <option key={a} value={a}>
//                     {a}
//                   </option>
//                 ))}
//               </select>
//             )}
//           </div>
//         </div>
//       </section>

//       {/* Error Message */}
//       {error && (
//         <div className="flex items-center justify-between rounded-xl border border-danger-border bg-danger-soft p-3 text-xs text-danger">
//           <p>{error}</p>
//           <button type="button" onClick={load} className="font-semibold underline hover:no-underline">
//             Retry
//           </button>
//         </div>
//       )}

//       {/* 4. Assignment Report Table */}
//       <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-xs">
//         <div className="overflow-x-auto">
//           <table className="w-full text-left text-xs">
//             <thead>
//               <tr className="border-b border-line bg-surface-muted/50 text-[11px] font-semibold uppercase tracking-wider text-muted">
//                 <th className="py-3 pl-5 pr-3">Time & Date</th>
//                 <th className="py-3 px-3">Customer / Chat</th>
//                 <th className="py-3 px-3">Assignment Flow</th>
//                 <th className="py-3 px-3">Assigned By</th>
//                 <th className="py-3 pl-3 pr-5">Reason Given</th>
//               </tr>
//             </thead>
//             <tbody className="divide-y divide-line-soft">
//               {rows === null && !error && (
//                 <tr>
//                   <td colSpan={5} className="py-12 text-center text-muted">
//                     <div className="flex flex-col items-center justify-center gap-2">
//                       <svg className="h-6 w-6 animate-spin text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
//                         <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
//                       </svg>
//                       <p className="text-xs">Loading assignment report…</p>
//                     </div>
//                   </td>
//                 </tr>
//               )}

//               {rows !== null && filteredRows.length === 0 && (
//                 <tr>
//                   <td colSpan={5} className="py-12 text-center text-muted">
//                     <div className="mx-auto flex max-w-sm flex-col items-center justify-center gap-2">
//                       <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-muted">
//                         <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
//                           <circle cx="11" cy="11" r="8" />
//                           <path d="m21 21-4.3-4.3" />
//                         </svg>
//                       </div>
//                       <p className="font-semibold text-ink">No assignment records found</p>
//                       <p className="text-[11px] text-muted">
//                         {searchQuery || filterType !== 'all' || selectedAssignee
//                           ? 'Try adjusting your search criteria or filter options.'
//                           : 'No assignments or transfers occurred during the selected date range.'}
//                       </p>
//                       {(searchQuery || filterType !== 'all' || selectedAssignee) && (
//                         <button
//                           type="button"
//                           onClick={() => {
//                             setSearchQuery('');
//                             setFilterType('all');
//                             setSelectedAssignee('');
//                           }}
//                           className="mt-2 text-xs font-semibold text-primary hover:underline"
//                         >
//                           Clear all filters
//                         </button>
//                       )}
//                     </div>
//                   </td>
//                 </tr>
//               )}

//               {paginatedRows.map((r) => (
//                 <tr key={r.id} className="transition hover:bg-surface-muted/60 align-top">
//                   {/* Time & Date */}
//                   <td className="whitespace-nowrap py-3.5 pl-5 pr-3">
//                     <p className="font-semibold text-ink">{dayLabel(r.createdAt)}</p>
//                     <p className="text-[11px] text-muted">{formatDateTime(r.createdAt)}</p>
//                   </td>

//                   {/* Customer / Chat */}
//                   <td className="py-3.5 px-3">
//                     <div className="flex items-center gap-2.5">
//                       <ContactAvatar contact={{ name: r.contactName, waId: r.contactWaId }} size="h-8 w-8 text-xs" />
//                       <div className="min-w-0">
//                         <p className="truncate font-semibold text-ink max-w-[160px]" title={r.contactName || `+${r.contactWaId}`}>
//                           {r.contactName || 'WhatsApp Contact'}
//                         </p>
//                         <div className="flex items-center gap-1.5 text-[11px] text-muted">
//                           <span>+{r.contactWaId}</span>
//                           <span>·</span>
//                           <Link
//                             href={`/inbox?chat=${r.conversationId}`}
//                             className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
//                             title="Open conversation in inbox"
//                           >
//                             <span>Open</span>
//                             <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
//                               <path d="M7 17l9.2-9.2M17 17V8H8" />
//                             </svg>
//                           </Link>
//                         </div>
//                       </div>
//                     </div>
//                   </td>

//                   {/* Flow: Previous -> New */}
//                   <td className="py-3.5 px-3">
//                     <div className="flex items-center gap-1.5 text-xs">
//                       <PartyPill party={r.previousAssignee} fallback="Unassigned" />
//                       <svg className="h-3.5 w-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
//                         <path d="M5 12h14" />
//                         <path d="m12 5 7 7-7 7" />
//                       </svg>
//                       <PartyPill party={r.newAssignee} fallback="Unassigned" />
//                     </div>
//                   </td>

//                   {/* Assigned By */}
//                   <td className="py-3.5 px-3 whitespace-nowrap">
//                     <div className="flex items-center gap-1.5">
//                       <span className="font-medium text-ink">{r.assignedBy?.name ?? 'System'}</span>
//                       <span
//                         className={`inline-flex items-center rounded-full px-1.5 py-px text-[9px] font-semibold uppercase ${
//                           r.assignedBy?.name ? 'bg-surface-strong text-muted' : 'bg-surface-strong text-faint'
//                         }`}
//                       >
//                         {r.assignedBy?.name ? 'Manual' : 'System'}
//                       </span>
//                     </div>
//                   </td>

//                   {/* Reason Given */}
//                   <td className="py-3.5 pl-3 pr-5">
//                     {r.reason ? (
//                       <div className="max-w-xs rounded-xl border border-line-soft bg-surface-muted px-3 py-1.5 text-xs text-ink leading-relaxed whitespace-pre-wrap break-words">
//                         <p className="italic font-normal">&ldquo;{r.reason}&rdquo;</p>
//                       </div>
//                     ) : (
//                       <span className="text-faint text-xs">—</span>
//                     )}
//                   </td>
//                 </tr>
//               ))}
//             </tbody>
//           </table>
//         </div>

//         {/* Table Footer / Pagination */}
//         {filteredRows.length > 0 && (
//           <div className="flex flex-col gap-3 border-t border-line-soft px-5 py-3 sm:flex-row sm:items-center sm:justify-between text-xs text-muted">
//             <p>
//               Showing <span className="font-medium text-ink">{(currentPage - 1) * pageSize + 1}</span> to{' '}
//               <span className="font-medium text-ink">{Math.min(currentPage * pageSize, filteredRows.length)}</span> of{' '}
//               <span className="font-medium text-ink">{filteredRows.length}</span> records
//               {filteredRows.length !== (rows?.length ?? 0) && (
//                 <span className="text-faint"> (filtered from {rows?.length ?? 0})</span>
//               )}
//             </p>

//             {totalPages > 1 && (
//               <div className="flex items-center gap-1.5">
//                 <button
//                   type="button"
//                   disabled={currentPage <= 1}
//                   onClick={() => setPage((p) => Math.max(1, p - 1))}
//                   className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-body hover:bg-surface-strong disabled:opacity-40"
//                 >
//                   Previous
//                 </button>
//                 <span className="px-2 text-xs font-medium text-ink">
//                   {currentPage} / {totalPages}
//                 </span>
//                 <button
//                   type="button"
//                   disabled={currentPage >= totalPages}
//                   onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
//                   className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-body hover:bg-surface-strong disabled:opacity-40"
//                 >
//                   Next
//                 </button>
//               </div>
//             )}
//           </div>
//         )}
//       </section>
//     </div>
//   );
// }
