import { Link } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { stageLabel, useImport } from '../../state/importStore';
import { ProgressBar } from '../ui';

/** Compact import status shown in the sidebar while an import runs in the background. */
export function ImportStatusPill() {
  const job = useImport((s) => s.job);
  if (!job) return null;
  const done = job.stage === 'done';
  const err = job.stage === 'error';
  return (
    <Link
      to={done && job.songId ? `/studio/${job.songId}` : '/import'}
      className="focus-ring block rounded-xl border border-ink-700 bg-ink-850 p-3 transition-colors hover:border-ink-600"
    >
      <div className="flex items-center gap-2 text-[12.5px]">
        {done ? <CheckCircle2 size={14} className="text-ok" /> : err ? <XCircle size={14} className="text-bad" /> : <Loader2 size={14} className="animate-spin text-accent-400" />}
        <span className="truncate font-medium text-ink-100">{job.title}</span>
      </div>
      <p className="mt-1 text-[11.5px] text-ink-300">{done ? 'Ready — open in Studio' : stageLabel(job, job.stage)}</p>
      {!done && !err && (
        <div className="mt-2">
          <ProgressBar value={job.progress} />
        </div>
      )}
    </Link>
  );
}
