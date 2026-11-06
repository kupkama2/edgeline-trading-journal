/**
 * The owner's own tools: the terminal, the screener and the portfolio
 * exist only for the account that owns the journal (accounts.is_owner,
 * claimed once by OWNER_EMAIL). To anyone else the routes answer 404, as
 * if they were not there, and the tabs are not drawn.
 */
import type { NextFunction, Request, Response } from "express";

export const isAdmin = (req: Request): boolean => req.account?.isOwner === true;

/** A guard for a route prefix: the owner passes, everyone else gets a 404. */
export function adminOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isAdmin(req)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  next();
}
