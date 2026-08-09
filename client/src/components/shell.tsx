import { useEffect, useState, createContext, useContext } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  BarChart3,
  CalendarDays,
  Check,
  LineChart,
  NotebookPen,
  Palette,
  Settings2,
} from "lucide-react";
import { XpChip, XpToaster } from "@/components/xp";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/* --------------------------------- theme -------------------------------- */

/**
 * Themes are token sets in index.css, selected by a data-theme attribute; this
 * provider only decides which one is on. The choice persists — a trader who
 * picked Terminal yesterday should not be handed Ember every morning.
 */
export const THEMES = [
  { id: "ember", name: "Ember", dark: true, swatch: "hsl(6 85% 57%)" },
  { id: "terminal", name: "Terminal", dark: true, swatch: "hsl(145 75% 44%)" },
  { id: "midnight", name: "Midnight", dark: true, swatch: "hsl(213 95% 60%)" },
  { id: "paper", name: "Paper", dark: false, swatch: "hsl(220 12% 87%)" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const THEME_KEY = "edgeline.theme";

function storedTheme(): ThemeId {
  const raw = localStorage.getItem(THEME_KEY);
  return THEMES.some((t) => t.id === raw) ? (raw as ThemeId) : "ember";
}

const ThemeCtx = createContext<{ theme: ThemeId; setTheme: (t: ThemeId) => void }>({
  theme: "ember",
  setTheme: () => {},
});

export const useTheme = () => useContext(ThemeCtx);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeId>(storedTheme);

  useEffect(() => {
    const root = document.documentElement;
    const def = THEMES.find((t) => t.id === theme)!;
    // One beat of cross-fade around the swap, then remove it — a permanent
    // global transition would make every hover feel gluey.
    root.classList.add("theme-anim");
    root.classList.toggle("dark", def.dark);
    root.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    const t = setTimeout(() => root.classList.remove("theme-anim"), 300);
    return () => clearTimeout(t);
  }, [theme]);

  return (
    <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>
  );
}

/* --------------------------------- logo --------------------------------- */

export function Logo({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-label="Edgeline logo"
      role="img"
      className={className}
    >
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="8"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.5"
      />
      <path
        d="M6 23 L13 14 L18 19 L26 8"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="26" cy="8" r="2.6" fill="currentColor" />
    </svg>
  );
}

/* --------------------------------- shell -------------------------------- */

const NAV = [
  { href: "/", label: "Journal", icon: NotebookPen },
  { href: "/daily", label: "Daily", icon: CalendarDays },
  { href: "/stats", label: "Stats", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Choose theme"
          data-testid="button-theme"
        >
          <Palette className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        {THEMES.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onClick={() => setTheme(t.id)}
            data-testid={`theme-${t.id}`}
            className="gap-2 text-xs"
          >
            <span
              className="h-3 w-3 rounded-full border border-border"
              style={{ background: t.swatch }}
            />
            {t.name}
            {theme === t.id && <Check className="ml-auto h-3 w-3" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/">
            <a className="flex items-center gap-2 shrink-0" data-testid="link-home">
              <Logo className="h-6 w-6 text-primary" />
              <span className="text-sm font-bold tracking-tight">Edgeline</span>
            </a>
          </Link>

          <nav className="ml-2 flex items-center gap-1 overflow-x-auto">
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = location === href;
              return (
                <Link key={href} href={href}>
                  <a
                    data-testid={`link-${label.toLowerCase()}`}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{label}</span>
                  </a>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <XpChip />
            <ThemePicker />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <XpToaster />
    </div>
  );
}
