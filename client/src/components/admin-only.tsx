import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import type { SessionResponse } from "@/components/login-gate";

/** Whether this visit is the demo journal: sample data, and the owner's screener to look at but not to drive. */
export function useIsDemo(): boolean {
  return useQuery<SessionResponse>({ queryKey: ["/api/session"] }).data?.demo === true;
}

/** A page for the owner that a demo visitor may also look at. */
export function adminOrDemo<P extends object>(Page: ComponentType<P>, NotFound: ComponentType) {
  return function AdminOrDemoPage(props: P) {
    const session = useQuery<SessionResponse>({ queryKey: ["/api/session"] });
    if (session.isLoading) return null;
    if (!session.data?.admin && !session.data?.demo) return <NotFound />;
    return <Page {...props} />;
  };
}

/** A page that exists only for the journal's owner; anyone else sees what an unknown address shows. */
export function adminOnly<P extends object>(Page: ComponentType<P>, NotFound: ComponentType) {
  return function AdminPage(props: P) {
    const session = useQuery<SessionResponse>({ queryKey: ["/api/session"] });
    if (session.isLoading) return null;
    if (!session.data?.admin) return <NotFound />;
    return <Page {...props} />;
  };
}
