// Public browser configuration. The anon/publishable key is intentionally public;
// database access is protected by Supabase Auth and Row Level Security.
window.TASK_SYNC_CONFIG = Object.freeze({
  supabaseUrl: "https://zlezrdbloffdrkakqyiq.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsZXpyZGJsb2ZmZHJrYWtxeWlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NTIzNzQsImV4cCI6MjEwNDAyODM3NH0.5qgaud4cRK7dp4XOhAwtoIIcYw2HrUjQvSljQbTpuEo",
  googleOAuthScopes: "https://www.googleapis.com/auth/tasks",
});
