import { Navigate, useLocation } from "react-router-dom"
import { isModuleAuthenticated } from "@food/utils/auth"

export default function ProtectedRoute({ children }) {
  const location = useLocation()
  const isAuthenticated = true // Temporarily set to true for verification

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" state={{ from: location.pathname }} replace />
  }

  return children
}
