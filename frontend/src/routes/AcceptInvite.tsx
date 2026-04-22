import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";

// Invite / recovery flow entry point. Supabase redirects the user here with
// either a PKCE `code` in the query string (modern flow) or a recovery token
// in the URL fragment. We exchange the code first, then prompt for a password.
// After successful password set we call `finalize_self_activation` to flip
// public.users.status from 'pending' → 'active' per spec §4.3.

type PasswordForm = { password: string; confirm: string };

export function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const [exchangeState, setExchangeState] = useState<
    "idle" | "exchanging" | "ready" | "error"
  >("idle");
  const [apiError, setApiError] = useState<string | null>(null);
  const [activationState, setActivationState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle");
  const navigate = useNavigate();

  const { register, handleSubmit, watch, formState } = useForm<PasswordForm>();
  const password = watch("password");

  useEffect(() => {
    const code = searchParams.get("code");
    if (!code) {
      setExchangeState("ready");
      return;
    }
    setExchangeState("exchanging");
    supabase.auth
      .exchangeCodeForSession(code)
      .then(({ error }) => {
        if (error) {
          setExchangeState("error");
          setApiError(error.message);
        } else {
          setExchangeState("ready");
        }
      })
      .catch((err) => {
        setExchangeState("error");
        setApiError(err instanceof Error ? err.message : String(err));
      });
  }, [searchParams]);

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
        <div>
          <h1 className="text-xl font-semibold">Set your password</h1>
          <p className="text-sm text-ink-muted mt-1">
            Pick a password of at least 12 characters with letters and digits.
          </p>
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
