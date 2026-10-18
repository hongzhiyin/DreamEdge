import { useLayoutEffect, useRef, useState } from 'react';

interface Position { top: number; stick: boolean }
function read(id: string): Position {
  try {
    const value = JSON.parse(sessionStorage.getItem(`dreamedge:scroll:${id}`) ?? 'null') as Position | null;
    if (value && Number.isFinite(value.top) && value.top >= 0 && typeof value.stick === 'boolean') return value;
  } catch { /* No saved reading position. */ }
  return { top: 0, stick: true };
}
export function useReadingPosition(id: string, content: unknown) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef('');
  const position = useRef<Position>({ top: 0, stick: true });
  const [away, setAway] = useState(false);
  function remember(): void {
    const node = container.current;
    if (!node) return;
    position.current = { top: node.scrollTop, stick: node.scrollHeight - node.scrollTop - node.clientHeight < 80 };
    setAway(!position.current.stick);
    try { sessionStorage.setItem(`dreamedge:scroll:${id}`, JSON.stringify(position.current)); } catch { /* Optional UI state. */ }
  }
  useLayoutEffect(() => {
    const node = container.current;
    if (!node || !id) return;
    if (current.current !== id) { current.current = id; position.current = read(id); }
    node.scrollTop = position.current.stick ? node.scrollHeight : position.current.top;
    setAway(!position.current.stick);
  }, [id, content]);
  function latest(): void {
    if (!container.current) return;
    position.current.stick = true; container.current.scrollTop = container.current.scrollHeight; remember();
  }
  return { container, away, remember, latest };
}
