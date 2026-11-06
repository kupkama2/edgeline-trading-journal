import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import type { SessionResponse } from "@/components/login-gate";

/** A page that exists only for the journal's owner; anyone else sees what an unknown address shows. */
export function adminOnly<P extends object>(Page: ComponentType<P>, NotFound: ComponentType) {
  return function AdminPage(props: P) {
    const session = useQuery<SessionResponse>({ queryKey: ["/api/session"] });
    if (session.isLoading) return null;
    if (!session.data?.admin) return <NotFound />;
    return <Page {...props} />;
  };
}
