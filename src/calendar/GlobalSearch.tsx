import { memo } from 'react';
import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Entry, entryTypes } from '../calendar';
import { dateLabel, searchEntries } from '../model';
export default memo(function GlobalSearch({
  entries,
  dateFormat,
  onSelect,
}: {
  entries: Entry[];
  dateFormat: string;
  onSelect: (entry: Entry) => void;
}) {
  const [query, setQuery] = useState(''),
    [debounced, setDebounced] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [active, setActive] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchEntries(entries, debounced), [entries, debounced]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query);
      setActive(-1);
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (active >= 0)
      document.getElementById('result-' + active)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSearchOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  function select(entry: Entry) {
    setSearchOpen(false);
    onSelect(entry);
  }
  return (
    <div className="search-container" ref={searchRef}>
      <div className="search">
        <Search size={21} />
        <input
          role="combobox"
          aria-label="Поиск записей"
          aria-controls="search-results"
          aria-expanded={searchOpen && !!query.trim()}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `result-${active}` : undefined}
          placeholder="Поиск по названию и комментарию"
          value={query}
          onFocus={() => setSearchOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setSearchOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearchOpen(false);
              e.stopPropagation();
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSearchOpen(true);
              setActive((v) =>
                Math.max(0, Math.min(results.length - 1, v + (e.key === 'ArrowDown' ? 1 : -1))),
              );
            }
            if (e.key === 'Enter' && searchOpen && results[active]) {
              e.preventDefault();
              select(results[active]);
            }
          }}
        />
        {query && (
          <button
            className="icon-button"
            aria-label="Очистить поиск"
            onClick={() => {
              setQuery('');
              setDebounced('');
            }}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {searchOpen && query.trim() && (
        <div id="search-results" role="listbox" className="search-results">
          {results.length ? (
            results.map((e, i) => (
              <button
                key={e.id}
                id={`result-${i}`}
                role="option"
                aria-selected={active === i}
                className={active === i ? 'selected' : ''}
                onMouseEnter={() => setActive(i)}
                onClick={() => select(e)}
              >
                <strong>{e.title}</strong>
                <span>
                  {entryTypes[e.type].label} · {dateLabel(e.date, dateFormat)} · {e.time}
                </span>
              </button>
            ))
          ) : (
            <p role="status">Ничего не найдено</p>
          )}
        </div>
      )}
    </div>
  );
});
