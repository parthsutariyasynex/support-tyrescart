'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaUrl } from '@/lib/media';
import { VOICE_MAX_MS, VOICE_MIN_MS, formatDuration, micErrorMessage, pickRecordingType } from '@/lib/voice';

// Only one voice note plays at a time (like WhatsApp): starting one pauses the others
const PLAY_EVENT = 'app:voice-play';

// WhatsApp-style voice note player: play/pause, a progress bar you can click or drag, and the time (total until
// played, then the position). `src` is a ready URL (the recording preview); otherwise the message's stored file is
// loaded with the sign-in token. `durationMs` is used when the file doesn't say (some recordings don't).
export function VoicePlayer({ messageId, src: givenSrc, durationMs, tone = 'bubble' }: { messageId?: string; src?: string; durationMs?: number; tone?: 'bubble' | 'plain' }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<string | null>(givenSrc ?? null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0); // seconds
  const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);
  const id = useRef(Math.random().toString(36).slice(2));

  useEffect(() => {
    if (givenSrc) return setSrc(givenSrc);
    if (!messageId) return;
    let cancelled = false;
    mediaUrl(messageId)
      .then((u) => !cancelled && setSrc(u))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [messageId, givenSrc]);

  useEffect(() => {
    const onOther = (e: Event) => (e as CustomEvent<string>).detail !== id.current && audioRef.current?.pause();
    window.addEventListener(PLAY_EVENT, onOther);
    return () => window.removeEventListener(PLAY_EVENT, onOther);
  }, []);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: id.current }));
      a.play().catch((e) => setError((e as Error).message || "Couldn't play this voice message"));
    } else a.pause();
  }, []);

  const seek = (seconds: number) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    a.currentTime = Math.max(0, Math.min(seconds, duration));
    setPosition(a.currentTime);
  };

  if (error) return <p className="py-1 text-[12px] italic text-muted">🎤 {error}</p>;
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
  const shown = playing || position > 0 ? position * 1000 : duration * 1000;
  return (
    <div className={`flex w-64 max-w-full items-center gap-2.5 ${tone === 'plain' ? '' : 'py-0.5'}`} role="group" aria-label="Voice message">
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
          }}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
          }}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={(e) => {
            setPlaying(false);
            e.currentTarget.currentTime = 0;
            setPosition(0);
          }}
          onError={() => setError("Couldn't play this voice message")}
          className="hidden"
        />
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={!src}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary shadow-xs transition hover:bg-primary-hover disabled:opacity-50"
      >
        {playing ? (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg className="ml-0.5 h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
          </svg>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(position, duration || 0)}
          disabled={!duration}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Voice message progress"
          aria-valuetext={`${formatDuration(position * 1000)} of ${formatDuration(duration * 1000)}`}
          className="voice-progress h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line accent-primary disabled:cursor-default"
          style={{ background: `linear-gradient(to right, var(--color-primary) ${pct}%, var(--color-line) ${pct}%)` }}
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
          <span aria-label="Duration">{formatDuration(shown)}</span>
          <span aria-hidden="true">🎤</span>
        </div>
      </div>
    </div>
  );
}

type Phase = 'starting' | 'recording' | 'preview' | 'sending' | 'error';

// The composer while recording a voice note: asks for the microphone, records (timer, cancel, stop), then a preview
// to play, delete or send. Upload failures keep the recording so it can be sent again.
export function VoiceRecorder({ onSend, onClose }: { onSend: (recording: Blob) => Promise<void>; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState<{ blob: Blob; url: string; ms: number } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const discard = useRef(false);
  // Each start is numbered; a start that's no longer the latest (cancelled, closed, or React's development double
  // run) lets go of its microphone instead of recording alongside the real one
  const attempt = useRef(0);

  const releaseMic = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const start = useCallback(async () => {
    const mine = ++attempt.current;
    setError('');
    setPhase('starting');
    setElapsed(0);
    discard.current = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no media devices'), { name: 'NoMediaDevices' });
      const type = typeof MediaRecorder === 'undefined' ? null : pickRecordingType((t) => MediaRecorder.isTypeSupported(t));
      if (!type) throw Object.assign(new Error('no recorder'), { name: 'NoRecorder' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (mine !== attempt.current) {
        stream.getTracks().forEach((t) => t.stop()); // outdated: free the microphone, don't record
        return;
      }
      streamRef.current = stream;
      const rec = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32000 });
      recorderRef.current = rec;
      const parts: Blob[] = []; // this recording's own data
      chunks.current = parts;
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (streamRef.current === stream) streamRef.current = null;
        if (discard.current || mine !== attempt.current) return;
        const ms = Date.now() - startedAt.current;
        if (ms < VOICE_MIN_MS) {
          setError('Too short to send. Hold on a little longer: at least 1 second.');
          setPhase('error');
          return;
        }
        const blob = new Blob(parts, { type: rec.mimeType.split(';')[0] || type.split(';')[0] });
        setRecording({ blob, url: URL.createObjectURL(blob), ms });
        setPhase('preview');
      };
      rec.start(250);
      startedAt.current = Date.now();
      setPhase('recording');
    } catch (e) {
      if (mine !== attempt.current) return;
      releaseMic();
      setError(micErrorMessage(e));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    start();
    return () => {
      // Leaving (another chat, closed composer): stop and drop everything, free the microphone
      attempt.current++;
      discard.current = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      releaseMic();
    };
  }, [start]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= VOICE_MAX_MS) recorderRef.current?.stop(); // 15-minute limit
    }, 200);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    return () => {
      if (recording) URL.revokeObjectURL(recording.url);
    };
  }, [recording]);

  const cancel = () => {
    attempt.current++;
    discard.current = true;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    releaseMic();
    onClose();
  };
  const stop = () => recorderRef.current?.state === 'recording' && recorderRef.current.stop();
  const send = async () => {
    if (!recording) return;
    setPhase('sending');
    setError('');
    try {
      await onSend(recording.blob);
    } catch (e) {
      setError((e as Error).message);
      setPhase('preview'); // keep the recording: try again or delete
    }
  };

  const iconButton = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition';
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2 py-1.5">
        <button type="button" onClick={cancel} disabled={phase === 'sending'} title="Delete recording" aria-label="Delete recording" className={`${iconButton} text-faint hover:bg-danger-soft hover:text-danger disabled:opacity-40`}>
          <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
          </svg>
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-3 px-1">
          {phase === 'starting' && <span className="text-xs text-muted">Waiting for the microphone…</span>}
          {phase === 'recording' && (
            <>
              <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger" aria-hidden="true" />
              <span className="font-mono text-sm tabular-nums text-ink" aria-label="Recording time">
                {formatDuration(elapsed)}
              </span>
              <span className="truncate text-xs text-muted">Recording…</span>
            </>
          )}
          {(phase === 'preview' || phase === 'sending') && recording && <VoicePlayer src={recording.url} durationMs={recording.ms} tone="plain" />}
          {phase === 'error' && <span className="truncate text-xs text-muted">No recording</span>}
        </div>

        {phase === 'recording' && (
          <button type="button" onClick={stop} title="Stop recording" aria-label="Stop recording" className={`${iconButton} border border-danger text-danger hover:bg-danger-soft`}>
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          </button>
        )}
        {phase === 'error' && (
          <button type="button" onClick={start} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-primary hover:bg-surface-muted">
            Try again
          </button>
        )}
        {(phase === 'preview' || phase === 'sending') && (
          <button
            type="button"
            onClick={send}
            disabled={phase === 'sending'}
            aria-label="Send voice message"
            className="flex h-9 items-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-semibold text-on-primary shadow-xs transition hover:bg-primary-hover disabled:opacity-60"
          >
            {phase === 'sending' ? 'Sending…' : 'Send'}
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="m3.4 20.4 17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
