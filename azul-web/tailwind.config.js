/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'tile-blue': '#3b82f6',
        'tile-yellow': '#eab308',
        'tile-red': '#ef4444',
        'tile-black': '#1f2937',
        'tile-white': '#f3f4f6',
      },
      fontFamily: {
        'serif': ['Playfair Display', 'serif'],
        'sans': ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
