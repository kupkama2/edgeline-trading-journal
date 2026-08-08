import { Switch, Route, Router } from "wouter";
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
import Dashboard from "@/pages/dashboard";
import Analysis from "@/pages/analysis";
import Daily from "@/pages/daily";
import Settings from "@/pages/settings";
import TradeView from "@/pages/trade-view";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Journal} />
      <Route path="/daily" component={Daily} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/analysis" component={Analysis} />
      <Route path="/settings" component={Settings} />
      {/* One trade, one address — every click path lands here. */}
      <Route path="/trade/:id" component={TradeView} />
      <Route component={NotFound} />
    </Switch>
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
