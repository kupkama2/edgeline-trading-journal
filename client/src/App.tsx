import { Suspense, lazy, useRef } from "react";
import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell, ThemeProvider } from "@/components/shell";
import { GuardrailProvider } from "@/components/daily-guard";
import { StyleFilterProvider } from "@/lib/style-filter";
import { DenomProvider } from "@/lib/denom";
import { LoginGate } from "@/components/login-gate";
import NotFound from "@/pages/not-found";
import Journal from "@/pages/journal";
import TradeView from "@/pages/trade-view";

/**
 * The journal and a trade load with the app; everything else arrives when it
 * is opened.
 *
 * Those two ARE the app — you land on the journal and you click into a trade —
 * while Stats drags in a charting library, Daily a calendar and Settings a
 * pile of forms, none of which most sessions ever touch. Bundling them into
 * the first paint costs every visit to pay for the pages that a few of them
 * visit.
 */
const Daily = lazy(() => import("@/pages/daily"));
const Settings = lazy(() => import("@/pages/settings"));
const Stats = lazy(() => import("@/pages/stats"));

/** A page arriving over the network is a beat, not a blank screen. */
function PageFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
    </div>
  );
}

/**
 * A trade has its own address but is not its own screen.
 *
 * /trade/:id opens OVER whatever you were looking at: the page underneath
 * stays mounted, keeps its scroll position and its filters, and dismissing
 * the overlay puts you back exactly where you were rather than re-running the
 * page you came from. That is why the Switch is driven by a remembered
 * non-trade location instead of the live one — the router's idea of "the
 * page" deliberately lags behind the URL while a trade is open.
 *
 * The URL is still real: deep links, the back button and a refresh all work.
 * Arriving cold on /trade/:id simply shows the journal underneath.
 */
function AppRouter() {
  const [location] = useLocation();
  const onTrade = location.startsWith("/trade/");
  const lastPage = useRef("/");
  if (!onTrade) lastPage.current = location;

  return (
    <>
      <Suspense fallback={<PageFallback />}>
      <Switch location={onTrade ? lastPage.current : location}>
        <Route path="/" component={Journal} />
        <Route path="/calendar" component={Daily} />
        {/* The old address, kept working: it is in bookmarks and in every
            "open that day" handoff written before the rename. */}
        <Route path="/daily" component={Daily} />
        {/* One tab, two halves. The old two addresses still resolve — links
            and bookmarks outlive a navigation change — each landing on the
            half it used to be. */}
        <Route path="/stats" component={Stats} />
        <Route path="/dashboard" component={Stats} />
        <Route path="/analysis" component={Stats} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
      </Suspense>
      {onTrade && <TradeView under={lastPage.current} />}
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <LoginGate>
            <StyleFilterProvider>
              {/* Inside the gate, because the unit is remembered per account
                  the same way the filters are. */}
              <DenomProvider>
              <GuardrailProvider>
                <Router hook={useHashLocation}>
                  <Shell>
                    <AppRouter />
                  </Shell>
                </Router>
              </GuardrailProvider>
              </DenomProvider>
            </StyleFilterProvider>
          </LoginGate>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
