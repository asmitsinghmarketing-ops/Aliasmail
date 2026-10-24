import Icon from './Icon.jsx';

export default function Pager({ list, onPage }) {
  const { total, page, pageSize } = list;
  if (!total) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <div className="pager">
      <span className="muted small">
        {first}–{last} of {total}
      </span>
      <button className="icon-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} title="Newer">
        <Icon name="chevronLeft" />
      </button>
      <button className="icon-btn" disabled={last >= total} onClick={() => onPage(page + 1)} title="Older">
        <Icon name="chevronRight" />
      </button>
    </div>
  );
}
