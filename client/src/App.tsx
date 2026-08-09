import { useRef } from "react";
import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell, ThemeProvider } from "@/components/shell";
import { GuardrailProvider } from "@/components/daily-guard";
import { StyleFilterProvider } from "@/lib/style-filter";
import { LoginGate } from "@/components/login-gate";
import NotFound from "@/pages/not-found";
import Journal from "@/pages/journal";
import Daily from "@/pages/daily";
import Settings from "@/pages/settings";
import Stats from "@/pages/stats";
import TradeView from "@/pages/trade-view";

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
      <Switch location={onTrade ? lastPage.current : location}>
        <Route path="/" component={Journal} />
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
              <GuardrailProvider>
                <Router hook={useHashLocation}>
                  <Shell>
                    <AppRouter />
                  </Shell>
                </Router>
              </GuardrailProvider>
            </StyleFilterProvider>
          </LoginGate>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
