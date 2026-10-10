import type { Contact } from '@/lib/inbox';

// The customer's display name: their WhatsApp profile name, or their number when none was shared
export const contactDisplayName = (c: Pick<Contact, 'name' | 'waId'>) => c.name || `+${c.waId}`;

// Up to two initials from a real name ("Test Customer" -> "TC"); null when there's no name to use
function initials(name: string | null) {
  const letters = (name ?? '')
    .trim()
    .split(/\s+/)
    .map((w) => [...w].find((ch) => /\p{L}/u.test(ch)))
    .filter(Boolean) as string[];
  if (letters.length === 0) return null;
  return (letters[0] + (letters.length > 1 ? letters[letters.length - 1] : '')).toUpperCase();
}

// Default customer avatar, used wherever a contact is shown. WhatsApp's Cloud API doesn't share customers'
// profile photos, so this is initials from their real name, or a person icon when they have no name.
export function ContactAvatar({ contact, size = 'h-10 w-10 text-sm' }: { contact: Pick<Contact, 'name' | 'waId'>; size?: string }) {
  const text = initials(contact.name);
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 select-none items-center justify-center rounded-full bg-primary-soft font-bold text-primary ${size}`}
    >
      {text ?? (
        <svg className="h-1/2 w-1/2" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.2-8 5v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1c0-2.8-3.6-5-8-5Z" />
        </svg>
      )}
    </span>
  );
}
