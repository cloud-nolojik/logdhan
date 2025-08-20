module.exports = {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // L.O.G Brand Colors
        logdhan: {
          orange: {
            light: '#fb923c',  // Light orange for L
            DEFAULT: '#f97316', // Main orange
            dark: '#ea580c',    // Dark orange
          },
          blue: {
            light: '#60a5fa',  // Light blue for O
            DEFAULT: '#3b82f6', // Main blue
            dark: '#1d4ed8',    // Dark blue
          },
          green: {
            light: '#34d399',  // Light green for G
            DEFAULT: '#10b981', // Main green
            dark: '#059669',    // Dark green
          },
        },
        // Primary/Secondary using L.O.G colors
        primary: {
          DEFAULT: '#1e293b', // Dark slate for backgrounds
          dark: '#0f172a',
          light: '#334155',
        },
        secondary: {
          DEFAULT: '#3b82f6', // L.O.G Blue
          light: '#60a5fa',
          dark: '#1d4ed8',
        },
        accent: {
          orange: '#f97316',  // L.O.G Orange
          blue: '#3b82f6',    // L.O.G Blue
          green: '#10b981',   // L.O.G Green
        },
        // Keep existing for compatibility
        chartgreen: {
          light: '#34d399',   // Updated to L.O.G green
          DEFAULT: '#10b981', // L.O.G green
          dark: '#059669',
        },
        success: '#10b981',
        warning: '#f59e0b',
        error: '#ef4444',
        neutral: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
      },
      backgroundImage: {
        'main-gradient': 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #3b82f6 100%)',
        'hero-gradient': 'linear-gradient(135deg, #0f172a 0%, #1e293b 25%, #3b82f6 75%, #f97316 100%)',
        'card-gradient': 'linear-gradient(135deg, rgba(59, 130, 246, 0.1) 0%, rgba(16, 185, 129, 0.1) 100%)',
        'accent-gradient': 'linear-gradient(135deg, #f97316 0%, #3b82f6 50%, #10b981 100%)',
        'log-gradient': 'linear-gradient(135deg, #f97316 0%, #3b82f6 50%, #10b981 100%)',
      },
      boxShadow: {
        'glow': '0 0 20px rgba(249, 115, 22, 0.3)',  // Orange glow
        'glow-lg': '0 0 40px rgba(249, 115, 22, 0.4)',
        'glow-blue': '0 0 20px rgba(59, 130, 246, 0.3)',  // Blue glow
        'glow-green': '0 0 20px rgba(16, 185, 129, 0.3)', // Green glow
        'card': '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
      },
      animation: {
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'bounce-slow': 'bounce 3s infinite',
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
}; 