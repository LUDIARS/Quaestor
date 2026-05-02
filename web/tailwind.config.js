/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Foundation UI tokens (CSS variable refs)
        bg: "var(--c-bg)",
        surface: "var(--c-surface)",
        muted: "var(--c-muted)",
        border: "var(--c-border)",
        text: "var(--c-text)",
        subtle: "var(--c-subtle)",
        accent: "var(--c-accent)",
        warn: "var(--c-warn)",
        danger: "var(--c-danger)",
        ok: "var(--c-ok)",
      },
      fontFamily: {
        sans: ["var(--f-sans)"],
        mono: ["var(--f-mono)"],
      },
    },
  },
  plugins: [],
};
