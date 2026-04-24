import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Logo } from "@/components/Logo";

// Invite / recovery flow entry point. With flowType=implicit, Supabase puts
// access_token + refresh_token in the URL hash fragment. detectSessionInUrl
// (in lib/supabase.ts) installs the session on page load; this component
// just waits for it to land, strips the hash so tokens don't linger in
// history, then prompts for a password. After update we call
// finalize_self_activation to flip public.users.status pending → active
// per spec §4.3.

type PasswordForm = { password: string; confirm: string };

export function AcceptInvite() {
  const [exchangeState, setExchangeState] = useState<
    "idle" | "exchanging" | "ready" | "error"
  >("exchanging");
  const [apiError, setApiError] = useState<string | null>(null);
  const [activationState, setActivationState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle");
  const navigate = useNavigate();

  const { register, handleSubmit, watch, formState } = useForm<PasswordForm>();
  const password = watch("password");

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let timeoutId: number | null = null;

    // Supabase surfaces expired/invalid-link errors in the hash fragment.
    const hash = window.location.hash;
    if (hash.includes("error=")) {
      const params = new URLSearchParams(hash.slice(1));
      const raw =
        params.get("error_description") ??
        params.get("error") ??
        "Invite link is invalid or expired.";
      window.history.replaceState(null, "", window.location.pathname);
      setApiError(decodeURIComponent(raw.replace(/\+/g, " ")));
      setExchangeState("error");
      return;
    }

    const sessionReady = () => {
      if (cancelled) return;
      // Strip tokens out of the URL so they don't sit in browser history.
      if (window.location.hash) {
        window.history.replaceState(null, "", window.location.pathname);
      }
      setExchangeState("ready");
    };

    // detectSessionInUrl runs async on client init. Check first; if not yet
    // installed, wait for the auth-state event, and bail with an error after
    // a short timeout so a stale/reused link doesn't hang the page forever.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (session) {
        sessionReady();
        return;
      }
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, s) => {
        if (s) sessionReady();
      });
      unsubscribe = () => subscription.unsubscribe();
      timeoutId = window.setTimeout(() => {
        if (cancelled) return;
        setApiError(
          "This invite link has expired or was already used. Ask your admin to resend.",
        );
        setExchangeState("error");
      }, 2500);
    });

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      unsubscribe?.();
    };
  }, []);

  const onSubmit = async (values: PasswordForm) => {
    setApiError(null);
    if (values.password !== values.confirm) {
      setApiError("Passwords do not match");
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: values.password });
    if (error) {
      setApiError(error.message);
      return;
    }
    setActivationState("running");
    const { error: rpcErr } = await supabase.rpc("finalize_self_activation");
    if (rpcErr) {
      setActivationState("error");
      setApiError(rpcErr.message);
      return;
    }
    setActivationState("done");
    navigate("/", { replace: true });
  };

  if (exchangeState === "exchanging") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-ink-muted">Preparing your invite…</p>
      </div>
    );
  }

  if (exchangeState === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="invenio-card max-w-md">
          <h1 className="text-xl font-semibold mb-2">Invite link problem</h1>
          <p className="text-ink-muted mb-4">{apiError ?? "Unknown error"}</p>
          <p className="text-sm text-ink-muted">
            If this link is older than 24 hours it may have expired. Ask your admin to
            resend the invite.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="invenio-card w-full max-w-sm flex flex-col gap-4"
        noValidate
      >
        <div className="flex flex-col items-center gap-3 pb-2 border-b border-border">
          <Logo variant="lockup" size={40} />
          <div className="text-center">
            <h1 className="text-xl font-semibold">Set your password</h1>
            <p className="text-sm text-ink-muted mt-1">
              At least 12 characters with letters and digits.
            </p>
          </div>
        </div>

        <div>
          <label htmlFor="password" className="invenio-label">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            className="invenio-input"
            aria-invalid={!!formState.errors.password}
            {...register("password", {
              required: "Password is required",
              minLength: { value: 12, message: "At least 12 characters" },
            })}
          />
          {formState.errors.password && (
            <p className="invenio-error">{formState.errors.password.message}</p>
          )}
        </div>

        <div>
          <label htmlFor="confirm" className="invenio-label">
            Confirm password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            className="invenio-input"
            aria-invalid={!!formState.errors.confirm}
            {...register("confirm", {
              required: "Please confirm",
              validate: (v) => v === password || "Passwords do not match",
            })}
          />
          {formState.errors.confirm && (
            <p className="invenio-error">{formState.errors.confirm.message}</p>
          )}
        </div>

        {apiError && (
          <div
            role="alert"
            className="rounded-md bg-danger-soft border border-danger/40 px-3 py-2 text-sm text-danger-deep"
          >
            {apiError}
          </div>
        )}

        <button
          type="submit"
          className="invenio-btn-primary"
          disabled={formState.isSubmitting || activationState === "running"}
        >
          {activationState === "running"
            ? "Finalizing…"
            : formState.isSubmitting
            ? "Setting password…"
            : "Set password & continue"}
        </button>
      </form>
    </div>
  );
}
