import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Logo } from "@/components/Logo";

// Invite / recovery flow entry point.
//
// Preferred (and Outlook-resistant) flow: email templates send users to
//   /accept-invite?token_hash=<hash>&type=<invite|recovery|magic_link>
// We call supabase.auth.verifyOtp({ token_hash, type }) which POSTs the hash
// (consumption requires JS execution — email-scanner GET pre-fetch can't burn
// the token). On success a session is installed; we show the password form.
//
// Legacy fallbacks (still handled for in-flight emails sent before the
// 2026-05-05 template change):
//   - #error=... fragment from the old /auth/v1/verify endpoint
//   - implicit-flow #access_token=... fragment, picked up by detectSessionInUrl
//
// After password set we call finalize_self_activation to flip
// public.users.status pending → active per spec §4.3.

type PasswordForm = { password: string; confirm: string };

type EmailActionType = "invite" | "recovery" | "magiclink";

const isEmailActionType = (s: string | null): s is EmailActionType =>
  s === "invite" || s === "recovery" || s === "magiclink";

export function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const [exchangeState, setExchangeState] = useState<
    "idle" | "exchanging" | "ready" | "error"
  >("exchanging");
  const [apiError, setApiError] = useState<string | null>(null);
  const [actionType, setActionType] = useState<EmailActionType | null>(null);
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

    const fail = (message: string) => {
      if (cancelled) return;
      if (window.location.hash || window.location.search) {
        window.history.replaceState(null, "", window.location.pathname);
      }
      setApiError(message);
      setExchangeState("error");
    };

    const succeed = (type: EmailActionType | null) => {
      if (cancelled) return;
      if (window.location.hash || window.location.search) {
        window.history.replaceState(null, "", window.location.pathname);
      }
      setActionType(type);
      // magic_link doesn't need a password set — go straight to dashboard.
      if (type === "magiclink") {
        navigate("/", { replace: true });
        return;
      }
      setExchangeState("ready");
    };

    // Path 1 (preferred): token_hash + type in query string.
    const tokenHash = searchParams.get("token_hash");
    const typeParam = searchParams.get("type");
    if (tokenHash && isEmailActionType(typeParam)) {
      // Set actionType up front so error UI knows context (recovery vs invite).
      setActionType(typeParam);
      supabase.auth
        .verifyOtp({ token_hash: tokenHash, type: typeParam })
        .then(({ error }) => {
          if (error) fail(error.message);
          else succeed(typeParam);
        })
        .catch((err) =>
          fail(err instanceof Error ? err.message : String(err)),
        );
      return () => {
        cancelled = true;
      };
    }

    // Path 2 (legacy): error fragment from the old /auth/v1/verify endpoint.
    const hash = window.location.hash;
    if (hash.includes("error=")) {
      const params = new URLSearchParams(hash.slice(1));
      const raw =
        params.get("error_description") ??
        params.get("error") ??
        "Email link is invalid or expired.";
      fail(decodeURIComponent(raw.replace(/\+/g, " ")));
      return () => {
        cancelled = true;
      };
    }

    // Path 3 (legacy): implicit-flow #access_token=... installed by
    // detectSessionInUrl. Wait for the auth state to settle.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (session) {
        succeed(null);
        return;
      }
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, s) => {
        if (s) succeed(null);
      });
      unsubscribe = () => subscription.unsubscribe();
      timeoutId = window.setTimeout(() => {
        if (cancelled) return;
        setApiError(
          "This link has expired or was already used. Ask your admin to resend.",
        );
        setExchangeState("error");
      }, 2500);
    });

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      unsubscribe?.();
    };
  }, [searchParams, navigate]);

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
    // Recovery flows already have an active user — skip activation. Invite
    // (and unknown legacy paths) flip pending → active.
    if (actionType !== "recovery") {
      setActivationState("running");
      const { error: rpcErr } = await supabase.rpc("finalize_self_activation");
      if (rpcErr) {
        setActivationState("error");
        setApiError(rpcErr.message);
        return;
      }
      setActivationState("done");
    }
    navigate("/", { replace: true });
  };

  if (exchangeState === "exchanging") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-ink-muted">Preparing your link…</p>
      </div>
    );
  }

  if (exchangeState === "error") {
    const heading =
      actionType === "recovery" ? "Reset link problem" : "Email link problem";
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="invenio-card max-w-md">
          <h1 className="text-xl font-semibold mb-2">{heading}</h1>
          <p className="text-ink-muted mb-4">{apiError ?? "Unknown error"}</p>
          <p className="text-sm text-ink-muted">
            If this link is older than its TTL it may have expired. Request a
            new one — invite links last 24h, reset links last 1h.
          </p>
        </div>
      </div>
    );
  }

  const formHeading =
    actionType === "recovery" ? "Set a new password" : "Set your password";

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
            <h1 className="text-xl font-semibold">{formHeading}</h1>
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
