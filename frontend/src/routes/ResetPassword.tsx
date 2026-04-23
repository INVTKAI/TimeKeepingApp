import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Logo } from "@/components/Logo";

type Form = { email: string };

export function ResetPassword() {
  const { register, handleSubmit, formState } = useForm<Form>();
  const [sent, setSent] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const onSubmit = async (values: Form) => {
    setApiError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo: `${window.location.origin}/accept-invite`,
    });
    if (error) {
      setApiError(error.message);
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="invenio-card max-w-md">
          <h1 className="text-xl font-semibold mb-2">Check your email</h1>
          <p className="text-ink-muted mb-4">
            If the address exists in our records, you'll receive a reset link
            within a minute.
          </p>
          <Link to="/sign-in" className="text-brand hover:underline text-sm">
            Back to sign in
          </Link>
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
            <h1 className="text-xl font-semibold">Reset password</h1>
            <p className="text-sm text-ink-muted mt-1">
              We'll send a reset link to your email.
            </p>
          </div>
        </div>

        <div>
          <label htmlFor="email" className="invenio-label">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            className="invenio-input"
            aria-invalid={!!formState.errors.email}
            {...register("email", { required: "Email is required" })}
          />
          {formState.errors.email && (
            <p className="invenio-error">{formState.errors.email.message}</p>
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
          disabled={formState.isSubmitting}
        >
          {formState.isSubmitting ? "Sending…" : "Send reset link"}
        </button>

        <div className="text-center text-sm text-ink-muted">
          <Link to="/sign-in" className="text-brand hover:underline">
            Back to sign in
          </Link>
        </div>
      </form>
    </div>
  );
}
