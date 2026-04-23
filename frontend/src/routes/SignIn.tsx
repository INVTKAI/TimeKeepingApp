import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Logo } from "@/components/Logo";

type SignInForm = { email: string; password: string };

export function SignIn() {
  const { register, handleSubmit, formState } = useForm<SignInForm>();
  const [apiError, setApiError] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const from =
    (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/";

  const onSubmit = async (values: SignInForm) => {
    setApiError(null);
    const { error } = await supabase.auth.signInWithPassword(values);
    if (error) {
      setApiError(error.message);
      return;
    }
    navigate(from, { replace: true });
  };

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
            <h1 className="text-xl font-semibold text-ink-primary">Sign in</h1>
            <p className="text-sm text-ink-muted mt-1">Timekeeping</p>
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

        <div>
          <label htmlFor="password" className="invenio-label">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className="invenio-input"
            aria-invalid={!!formState.errors.password}
            {...register("password", { required: "Password is required" })}
          />
          {formState.errors.password && (
            <p className="invenio-error">{formState.errors.password.message}</p>
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
          {formState.isSubmitting ? "Signing in…" : "Sign in"}
        </button>

        <div className="text-center text-sm text-ink-muted">
          <Link to="/reset-password" className="text-brand hover:underline">
            Forgot your password?
          </Link>
        </div>
      </form>
    </div>
  );
}
