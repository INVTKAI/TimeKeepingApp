import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/context/AuthContext";
import { RequireAuth } from "@/routes/RequireAuth";
import { SignIn } from "@/routes/SignIn";
import { AcceptInvite } from "@/routes/AcceptInvite";
import { ResetPassword } from "@/routes/ResetPassword";
import { RootHandler } from "@/routes/RootHandler";
import { Exports } from "@/routes/Exports";
import { Users } from "@/routes/Users";
import { TimesheetsList } from "@/routes/TimesheetsList";
import { StaffTimesheet } from "@/routes/StaffTimesheet";
import { FieldTimesheet } from "@/routes/FieldTimesheet";
import { NewFieldTimesheet } from "@/routes/NewFieldTimesheet";
import { FlowsList } from "@/routes/FlowsList";
import { FlowEditor } from "@/routes/FlowEditor";

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
            <Route path="/" element={<RootHandler />} />
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
              path="/timesheets/field/new"
              element={
                <RequireAuth role="admin">
                  <NewFieldTimesheet />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/flows"
              element={
                <RequireAuth role="admin">
                  <FlowsList />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/flows/:id"
              element={
                <RequireAuth role="admin">
                  <FlowEditor />
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
