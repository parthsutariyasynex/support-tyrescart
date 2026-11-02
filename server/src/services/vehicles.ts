import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { requireContact } from './contacts.js';
import { notFound } from './errors.js';
import { getPermissions } from './permissions.js';
import { parse } from './validate.js';

// Customers' vehicles (chat header → Vehicles). Every team member can see and add them; dates are calendar days.

const text = (max: number, label: string) =>
  z
    .string({ message: `${label} must be text` })
    .trim()
    .max(max, `${label} is too long (max ${max} characters)`)
    .nullish()
    .transform((v) => v || null);

const requiredText = (max: number, label: string) =>
  z
    .string({ message: `Enter the ${label.toLowerCase()}` })
    .trim()
    .min(1, `Enter the ${label.toLowerCase()}`)
    .max(max, `${label} is too long (max ${max} characters)`);

const day = (label: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))), `${label} must be a date`)
    .refine((v) => v === null || v <= new Date().toISOString().slice(0, 10), `${label} can't be in the future`);

const vehicleSchema = z.object({
  contactId: z.string({ message: 'Choose a CRM customer' }).trim().min(1, 'Choose a CRM customer'),
  plateNumber: requiredText(20, 'Plate number').transform((v) => v.toUpperCase()),
  make: requiredText(60, 'Make'),
  model: requiredText(60, 'Model'),
  year: z
    .number({ message: 'Enter the year' })
    .int('Year must be a whole number')
    .min(1900, 'Year must be 1900 or later')
    .max(new Date().getFullYear() + 1, 'Year is in the future'),
  registrationDate: day('Registration date'),
  lastServiceDate: day('Last purchase / service date'),
  tireSize1: z.string({ message: 'Enter tire size 1' }).trim().min(1, 'Enter tire size 1').max(30, 'Tire size 1 is too long (max 30 characters)'),
  tireSize2: text(30, 'Tire size 2'),
});

type Row = Awaited<ReturnType<typeof prisma.vehicle.findFirstOrThrow>>;
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (v: string | null) => (v ? new Date(`${v}T00:00:00Z`) : null);
const shape = (v: Row) => ({ ...v, registrationDate: isoDay(v.registrationDate), lastServiceDate: isoDay(v.lastServiceDate) });
const announce = (workspaceId: string, contactId: string) => emitToWorkspace(workspaceId, 'contact:vehicles', { contactId });

export async function listVehicles(auth: AuthPayload, contactId: string) {
  await getPermissions(auth);
  await requireContact(auth.workspaceId, contactId);
  const rows = await prisma.vehicle.findMany({ where: { contactId, workspaceId: auth.workspaceId, deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return rows.map(shape);
}

// "CRM Customer" picker: contacts by name or number (up to 20)
export async function searchVehicleCustomers(auth: AuthPayload, search?: string | null) {
  await getPermissions(auth);
  const q = (search ?? '').trim().slice(0, 100);
  const digits = q.replace(/\D/g, '');
  return prisma.contact.findMany({
    where: {
      workspaceId: auth.workspaceId,
      deletedAt: null,
      ...(q ? { OR: [{ name: { contains: q } }, { firstName: { contains: q } }, { lastName: { contains: q } }, ...(digits ? [{ waId: { contains: digits } }] : [])] } : {}),
    },
    orderBy: [{ name: 'asc' }, { waId: 'asc' }],
    take: 20,
    select: { id: true, name: true, waId: true },
  });
}

export async function addVehicle(auth: AuthPayload, input: unknown) {
  await getPermissions(auth);
  const v = parse(vehicleSchema, input);
  await requireContact(auth.workspaceId, v.contactId);
  const row = await prisma.vehicle.create({
    data: {
      ...v,
      workspaceId: auth.workspaceId,
      registrationDate: toDate(v.registrationDate),
      lastServiceDate: toDate(v.lastServiceDate),
      createdBy: auth.userId,
      updatedBy: auth.userId,
    },
  });
  announce(auth.workspaceId, v.contactId);
  return shape(row);
}

export async function deleteVehicle(auth: AuthPayload, id: string) {
  await getPermissions(auth);
  const row = await prisma.vehicle.findFirst({ where: { id, workspaceId: auth.workspaceId, deletedAt: null } });
  if (!row) throw notFound('Vehicle');
  // Soft delete: the row stays, marked with who deleted it and when (updatedBy too; updatedAt is set automatically)
  await prisma.vehicle.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: auth.userId, updatedBy: auth.userId } });
  announce(auth.workspaceId, row.contactId);
  return true;
}
