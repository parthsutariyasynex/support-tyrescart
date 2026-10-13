export default function SettingsPage() {
  return null;
}


// 'use client';

// import { useState } from 'react';
// import { API_URL } from '@/lib/api';
// import { connectWhatsApp } from '@/lib/settings';
// import { AppShell, type Me } from '../AppShell';
// import { buttonClass, inputClass } from '../AuthShell';
// import { isAdminRole } from '@/lib/roles';
// import { TeamSection } from './team';

// export default function SettingsPage() {
//   // return <AppShell>{(me) => <Settings me={me} />}</AppShell>;
// }

// function Settings({ me }: { me: Me }) {
//   const [connected, setConnected] = useState(me.workspace.whatsapp?.displayPhone ?? null);
//   const [error, setError] = useState('');
//   const [loading, setLoading] = useState(false);
//   const [success, setSuccess] = useState(false);
//   // Only admins may change the WhatsApp connection (the server refuses everyone else)
//   const canEditSettings = isAdminRole(me.role);

//   async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
//     e.preventDefault();
//     setLoading(true);
//     setError('');
//     setSuccess(false);
//     try {
//       const form = new FormData(e.currentTarget);
//       const account = await connectWhatsApp({
//         wabaId: String(form.get('wabaId')),
//         phoneNumberId: String(form.get('phoneNumberId')),
//         accessToken: String(form.get('accessToken')),
//       });
//       setConnected(account.displayPhone);
//       setSuccess(true);
//     } catch (err) {
//       setError((err as Error).message);
//     }
//     setLoading(false);
//   }

//   // return (
//     // <div className="h-full overflow-y-auto bg-page p-6 lg:p-10">
//     //   <div className="mx-auto max-w-2xl space-y-6">
//     //     <div>
//     //       <h1 className="text-xl font-bold tracking-tight text-ink">Workspace Settings</h1>
//     //       <p className="text-xs text-muted mt-0.5">Manage your WhatsApp Business connection and Webhook configuration.</p>
//     //     </div>

      

//     //     {/* <TeamSection meId={me.user.id} role={me.role} />/ */}

        
//     //   </div>
//     // </div>
//   // );
// }




