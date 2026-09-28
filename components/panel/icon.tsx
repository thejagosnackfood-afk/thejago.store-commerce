export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    rocket:
      "M14 4c3-2 6-2 7-1 1 1 1 4-1 7l-8 8-6-6z M6 12H2l4-6h5 M12 18v4l6-4v-5 M5 16l-3 6 6-3 M15 7h.01",
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    box: "m12 3 9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9 M7 5l10 6",
    chat: "M5 3h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5l-4 3v-3H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M7 10h.01 M12 10h.01 M17 10h.01",
    order: "M6 3h12v19l-3-2-3 2-3-2-3 2z M9 7h6 M9 11h6 M9 15h3",
    chart: "M4 20V4h16v16z M8 16v-4 M12 16V9 M16 16V6 M7 8l8-3",
    link: "m9 15-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M15 9l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0 M8 16l8-8",
    image:
      "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M3 17l6-6 4 4 3-3 5 5 M8 7h.01",
    shop: "M3 10 5 3h14l2 7 M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0 M5 13v8h14v-8 M10 21v-6h4v6 M9 3v7 M15 3v7",
    users:
      "M16 21v-3a5 5 0 0 0-10 0v3z M11 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M18 4a4 4 0 0 1 0 7 M20 15a5 5 0 0 1 2 6",
    bell: "M4 17h16l-2-4V9a6 6 0 0 0-12 0v4z M10 21h4",
    search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
    calendar: "M3 5h18v16H3z M3 10h18 M7 2v5 M17 2v5",
    bag: "M5 7h14l1 14H4z M9 8V5a3 3 0 0 1 6 0v3",
    edit: "m4 16-1 5 5-1L21 7l-4-4z M14 6l4 4",
    arrow: "m9 5 7 7-7 7",
  };
  if (name === "kolkit")
    return (
      <span className="kolkit-symbol" aria-hidden="true">
        ✣
      </span>
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.grid} />
    </svg>
  );
}
