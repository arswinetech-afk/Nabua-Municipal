import { Link, useNavigate } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { Card, Button, IconArrowLeft, IconSearch } from '../components/ui'

export default function NotFound() {
  const { user } = useApp()
  const navigate = useNavigate()

  return (
    <div className="mx-auto max-w-lg">
      <Card className="card-pad text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <IconSearch className="h-6 w-6" />
        </span>
        <h1 className="mt-3 text-lg font-bold text-ink">This page does not exist</h1>
        <p className="mt-1 text-xs text-ink-soft">
          The link may be mistyped, or the screen may have moved. No member data is exposed on this page.
        </p>

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
            <IconArrowLeft /> Go back
          </Button>
          {user ? (
            <>
              <Link className="btn btn-primary btn-sm" to="/">Open the dashboard</Link>
              <Link className="btn btn-secondary btn-sm" to="/members">Search members</Link>
            </>
          ) : (
            <Link className="btn btn-primary btn-sm" to="/login">Sign in</Link>
          )}
        </div>

        {user && (
          <div className="mt-5 border-t border-line pt-4 text-left">
            <p className="text-[11px] font-semibold text-ink-soft uppercase">Common destinations</p>
            <ul className="mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              <li><Link className="link" to="/barangays">Barangay directory</Link></li>
              <li><Link className="link" to="/members">Member registry</Link></li>
              <li><Link className="link" to="/members/new">Add a member</Link></li>
              <li><Link className="link" to="/duplicates">Duplicate Review Center</Link></li>
              <li><Link className="link" to="/data-quality">Data Quality Center</Link></li>
              <li><Link className="link" to="/reports">Reports</Link></li>
            </ul>
          </div>
        )}
      </Card>
    </div>
  )
}
