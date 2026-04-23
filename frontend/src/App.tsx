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
import { MyTimesheets } from "@/routes/MyTimesheets";
import { FieldTimesheets } from "@/routes/FieldTimesheets";
import { StaffTimesheet } from "@/routes/StaffTimesheet";
import { FieldTimesheet } from "@/routes/FieldTimesheet";
import { NewFieldTimesheet } from "@/routes/NewFieldTimesheet";
import { FlowsList } from "@/routes/FlowsList";
import { FlowEditor } from "@/routes/FlowEditor";
import { AdminEmployees } from "@/routes/AdminEmployees";
import { AdminProjects } from "@/routes/AdminProjects";
import { AdminProjectDetail } from "@/routes/AdminProjectDetail";
import { AdminCodes } from "@/routes/AdminCodes";
import { AdminBadges } from "@/routes/AdminBadges";
import { AdminTimesheets } from "@/routes/AdminTimesheets";
import { AdminImports } from "@/routes/AdminImports";
import { WeeklyCheck } from "@/routes/WeeklyCheck";

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
            {/* Unauthenticated routes — render bare (no shell). */}
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />
            <Route path="/reset-password" element={<ResetPassword />} />

            {/* Root: handles invite/recovery redirect, otherwise Dashboard in shell. */}
            <Route path="/" element={<RootHandler />} />

            {/* Timesheet editors — wrapped in shell for v1 consistency. */}
            <Route
              path="/my-timesheets"
              element={
                <RequireAuth>
                  <MyTimesheets />
                </RequireAuth>
              }
            />
            <Route
              path="/field-timesheets"
              element={
                <RequireAuth>
                  <FieldTimesheets />
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
            <Route
              path="/timesheets/field/new"
              element={
                <RequireAuth role="admin">
                  <NewFieldTimesheet />
                </RequireAuth>
              }
            />
            <Route
              path="/weekly-check"
              element={
                <RequireAuth>
                  <WeeklyCheck />
                </RequireAuth>
              }
            />

            {/* Admin pages. */}
            <Route
              path="/admin/employees"
              element={
                <RequireAuth role="admin">
                  <AdminEmployees />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/projects"
              element={
                <RequireAuth role="admin">
                  <AdminProjects />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/projects/:id"
              element={
                <RequireAuth role="admin">
                  <AdminProjectDetail />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/codes"
              element={
                <RequireAuth role="admin">
                  <AdminCodes />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/badges"
              element={
                <RequireAuth role="admin">
                  <AdminBadges />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/timesheets"
              element={
                <RequireAuth role="admin">
                  <AdminTimesheets />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/imports"
              element={
                <RequireAuth role="admin">
                  <AdminImports />
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
              path="/admin/users"
              element={
                <RequireAuth role="admin">
                  <Users />
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

            {/* Back-compat redirects. */}
            <Route path="/users" element={<Navigate to="/admin/users" replace />} />
            <Route path="/timesheets" element={<Navigate to="/my-timesheets" replace />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
