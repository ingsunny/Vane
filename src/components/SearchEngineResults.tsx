/* eslint-disable @next/next/no-img-element */
import { Globe, PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Block, Chunk, ResearchBlock } from '@/lib/types';

type EngineResult = {
  title: string;
  url: string;
  engines: string[];
};

/**
 * Pull every web search result the agent gathered for this answer out of the
 * research blocks' `search_results` / `reading` substeps, dedupe by URL, and
 * keep the union of engines per URL.
 */
const collectResults = (blocks: Block[]): EngineResult[] => {
  const byUrl = new Map<string, EngineResult>();

  blocks
    .filter(
      (block): block is ResearchBlock =>
        block.type === 'research' && block.data?.subSteps?.length > 0,
    )
    .forEach((research) => {
      research.data.subSteps.forEach((step) => {
        if (step.type !== 'search_results' && step.type !== 'reading') return;

        step.reading.forEach((chunk: Chunk) => {
          const url = chunk.metadata?.url as string | undefined;
          if (!url) return;

          const engines = ((chunk.metadata?.engines as string[]) || []).filter(
            Boolean,
          );

          const existing = byUrl.get(url);
          if (existing) {
            existing.engines = Array.from(
              new Set([...existing.engines, ...engines]),
            );
          } else {
            byUrl.set(url, {
              title: (chunk.metadata?.title as string) || 'Untitled',
              url,
              engines,
            });
          }
        });
      });
    });

  return Array.from(byUrl.values());
};

const SearchEngineResults = ({ blocks }: { blocks: Block[] }) => {
  const [expanded, setExpanded] = useState(false);

  const results = useMemo(() => collectResults(blocks), [blocks]);

  const engines = useMemo(() => {
    const set = new Set<string>();
    results.forEach((r) => r.engines.forEach((e) => set.add(e)));
    return Array.from(set).sort();
  }, [results]);

  const [activeEngine, setActiveEngine] = useState<string>('all');

  if (results.length === 0 || engines.length === 0) return null;

  const filtered =
    activeEngine === 'all'
      ? results
      : results.filter((r) => r.engines.includes(activeEngine));

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="border border-dashed border-light-200 dark:border-dark-200 hover:bg-light-200 dark:hover:bg-dark-200 active:scale-95 duration-200 transition px-4 py-2 flex flex-row items-center justify-between rounded-lg dark:text-white text-sm w-full"
      >
        <div className="flex flex-row items-center space-x-2">
          <Globe size={17} />
          <p>Search engines ({engines.length})</p>
        </div>
        <PlusIcon className="text-[#24A0ED]" size={17} />
      </button>
    );
  }

  return (
    <div className="w-full flex flex-col space-y-2 rounded-lg border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary p-2">
      <div className="flex flex-row items-center space-x-2 px-1">
        <Globe size={16} className="text-black dark:text-white" />
        <p className="text-sm font-medium text-black dark:text-white">
          Search engines
        </p>
      </div>

      {/* Engine tabs */}
      <div className="flex flex-row flex-wrap gap-1.5">
        <button
          onClick={() => setActiveEngine('all')}
          className={`px-2 py-0.5 rounded-md text-xs font-medium border transition duration-200 ${
            activeEngine === 'all'
              ? 'bg-[#24A0ED] text-white border-[#24A0ED]'
              : 'bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 border-light-200 dark:border-dark-200 hover:bg-light-200 dark:hover:bg-dark-200'
          }`}
        >
          All ({results.length})
        </button>
        {engines.map((engine) => {
          const count = results.filter((r) =>
            r.engines.includes(engine),
          ).length;
          return (
            <button
              key={engine}
              onClick={() => setActiveEngine(engine)}
              className={`px-2 py-0.5 rounded-md text-xs font-medium capitalize border transition duration-200 ${
                activeEngine === engine
                  ? 'bg-[#24A0ED] text-white border-[#24A0ED]'
                  : 'bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 border-light-200 dark:border-dark-200 hover:bg-light-200 dark:hover:bg-dark-200'
              }`}
            >
              {engine} ({count})
            </button>
          );
        })}
      </div>

      {/* Results for the active tab */}
      <div className="flex flex-col space-y-1.5 max-h-80 overflow-y-auto pr-1">
        {filtered.map((result, idx) => {
          let domain = '';
          try {
            domain = new URL(result.url).hostname;
          } catch {
            domain = '';
          }
          const faviconUrl = domain
            ? `https://s2.googleusercontent.com/s2/favicons?domain=${domain}&sz=128`
            : '';

          return (
            <a
              key={`${result.url}-${idx}`}
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="flex flex-row items-start gap-2 rounded-md bg-light-100 dark:bg-dark-100 hover:bg-light-200 dark:hover:bg-dark-200 transition duration-200 p-2"
            >
              {faviconUrl && (
                <img
                  src={faviconUrl}
                  alt=""
                  className="w-4 h-4 rounded-sm flex-shrink-0 mt-0.5"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              )}
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-medium text-black dark:text-white line-clamp-2">
                  {result.title}
                </span>
                <span className="text-[11px] text-black/40 dark:text-white/40 truncate">
                  {domain}
                </span>
                {result.engines.length > 0 && (
                  <div className="flex flex-row flex-wrap gap-1 mt-1">
                    {result.engines.map((engine) => (
                      <span
                        key={engine}
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20"
                      >
                        {engine}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
};

export default SearchEngineResults;
