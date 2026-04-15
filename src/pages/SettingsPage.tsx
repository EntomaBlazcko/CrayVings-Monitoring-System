export default function SettingsPage() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <h2 className="mt-0 text-gray-800">Settings</h2>
      <p className="text-gray-600">System settings panel.</p>
      <p className="text-gray-600 mb-0">
        To change backend URL, set <strong>VITE_API_URL</strong> in your frontend environment.
      </p>
    </div>
  );
}
