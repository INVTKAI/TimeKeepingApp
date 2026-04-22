import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/context/AuthContext";
import { RequireAuth } from "@/routes/RequireAuth";
import { SignIn } from "@/routes/SignIn";
import { AcceptInvite } from "@/routes/AcceptInvite";
import { ResetPassword } from "@/routes/ResetPassword";
import { Dashboard } from "@/routes/Dashboard";
import { Exports } from "@/routes/Exports";
import { Users } from "@/routes/Users";
import { TimesheetsList } from "@/routes/TimesheetsList";
import { StaffTimesheet } from "@/routes/StaffTimesheet";
import { FieldTimesheet } from "@/routes/FieldTimesheet";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <Dashboard />
                </RequireAuth>
              }
            />
            <Route
              path="/exports"
              element={
                <RequireAuth role="admin">
                  <Exports />
                </RequireAuth>
              }
            />
            <Route
              path="/users"
              element={
                <RequireAuth role="admin">
                  <Users />
                </RequireAuth>
              }
            />
            <Route
              path="/timesheets"
              element={
                <RequireAuth>
                  <TimesheetsList />
                </RequireAuth>
              }
            />
            <Route
              path="/timesheets/staff/:id"
              element={
                <RequireAuth>
                  <StaffTimesheet />
                </RequireAuth>
              }
            />
            <Route
              path="/timesheets/field/:id"
              element={
                <RequireAuth>
                  <FieldTimesheet />
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
