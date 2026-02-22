"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { User } from "@supabase/supabase-js";
import { 
  User as UserIcon, 
  Mail, 
  Lock, 
  Save, 
  Loader2,
  CheckCircle,
  AlertCircle
} from "lucide-react";

export default function ProfileClient({ user }: { user: User }) {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (!user.email) {
      setMessage({ type: "error", text: "User email not found" });
      return;
    }

    if (!oldPassword) {
      setMessage({ type: "error", text: "Please enter your current password" });
      return;
    }

    if (password !== confirmPassword) {
      setMessage({ type: "error", text: "New passwords do not match" });
      return;
    }

    if (password.length < 6) {
      setMessage({ type: "error", text: "New password must be at least 6 characters" });
      return;
    }

    try {
      setLoading(true);

      // Verify old password by attempting to sign in
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: oldPassword,
      });

      if (signInError) {
        throw new Error("Incorrect current password");
      }

      const { error } = await supabase.auth.updateUser({
        password: password
      });

      if (error) {
        throw error;
      }

      setMessage({ type: "success", text: "Password updated successfully" });
      setOldPassword("");
      setPassword("");
      setConfirmPassword("");
    } catch (error: any) {
      setMessage({ type: "error", text: error.message || "Failed to update password" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3 mb-8">
        <div className="p-3 bg-brand-100 rounded-xl">
          <UserIcon className="w-6 h-6 text-brand-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Profile Settings</h1>
          <p className="text-gray-500">Manage your account settings and password</p>
        </div>
      </div>

      {/* Profile Details Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <UserIcon className="w-4 h-4 text-gray-500" />
            Account Information
          </h2>
        </div>
        <div className="p-6 space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="email"
                  value={user.email}
                  disabled
                  className="block w-full pl-10 pr-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-gray-500 sm:text-sm"
                />
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Email address is managed by your administrator and cannot be changed.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                User ID
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <UserIcon className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  value={user.id}
                  disabled
                  className="block w-full pl-10 pr-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-gray-500 sm:text-sm font-mono"
                />
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-gray-100">
             <div className="flex items-center gap-2 text-sm text-gray-500">
                <span className="font-medium">Last Sign In:</span>
                <span>{user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : 'N/A'}</span>
             </div>
          </div>
        </div>
      </div>

      {/* Change Password Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <Lock className="w-4 h-4 text-gray-500" />
            Change Password
          </h2>
        </div>
        <div className="p-6">
          <form onSubmit={handleUpdatePassword} className="space-y-4 max-w-md">
            {message && (
              <div className={`p-4 rounded-lg flex items-start gap-3 ${
                message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}>
                {message.type === 'success' ? (
                  <CheckCircle className="w-5 h-5 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                )}
                <span className="text-sm font-medium">{message.text}</span>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Current Password
              </label>
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                className="block w-full px-3 py-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-colors"
                placeholder="Enter current password"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                New Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full px-3 py-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-colors"
                placeholder="Enter new password"
                required
                minLength={6}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Confirm New Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="block w-full px-3 py-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-colors"
                placeholder="Confirm new password"
                required
                minLength={6}
              />
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={loading}
                className="flex items-center justify-center gap-2 w-full sm:w-auto px-6 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Updating...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Update Password
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
