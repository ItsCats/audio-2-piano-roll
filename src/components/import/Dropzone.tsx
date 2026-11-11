import { useRef, useState, type ReactNode } from 'react';
import { UploadCloud } from 'lucide-react';
import { cn } from '../ui';

export const ACCEPT = '.mp3,.wav,.m4a,.mp4,.aac,.ogg,.oga,.opus,.flac,.webm,.mov,.mkv,.aif,.aiff,.mid,.midi,.kar,audio/*,video/*';

export function Dropzone({ onFile, compact, children }: { onFile: (f: File) => void; compact?: boolean; children?: ReactNode }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={cn(
        'focus-ring group flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed text-center transition-colors',
        compact ? 'gap-2 px-5 py-7' : 'gap-3 px-6 py-12',
        over ? 'border-accent-400 bg-accent-500/10' : 'border-ink-600 bg-ink-900/60 hover:border-ink-500 hover:bg-ink-850',
      )}
    >
      <div className={cn('flex items-center justify-center rounded-2xl bg-ink-800 text-accent-400 transition-transform group-hover:scale-105', compact ? 'h-10 w-10' : 'h-14 w-14')}>
        <UploadCloud size={compact ? 20 : 26} strokeWidth={1.7} />
      </div>
      {children ?? (
        <>
          <p className="text-[15px] font-medium text-ink-50">Drop a song here, or click to browse</p>
          <p className="text-[12.5px] text-ink-300">MP3, WAV, M4A, MP4, FLAC, OGG, WebM · MIDI files</p>
        </>
      )}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
