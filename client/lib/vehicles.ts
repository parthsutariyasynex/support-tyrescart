import { gql } from './api';

// Customers' vehicles (chat header → Vehicles). Dates are calendar days, yyyy-mm-dd.
export type Vehicle = {
  id: string;
  contactId: string;
  plateNumber: string;
  make: string;
  model: string;
  year: number;
  registrationDate: string | null;
  lastServiceDate: string | null;
  tireSize1: string;
  tireSize2: string | null;
  createdAt: string;
};
export type VehicleInput = Omit<Vehicle, 'id' | 'createdAt'>;
export type VehicleCustomer = { id: string; name: string | null; waId: string };

// A customer's vehicles changed (by anyone): { contactId } — relayed from the socket's contact:vehicles
export const VEHICLES_EVENT = 'crm:contact-vehicles';

const FIELDS = 'id contactId plateNumber make model year registrationDate lastServiceDate tireSize1 tireSize2 createdAt';

export async function listVehicles(contactId: string) {
  return (await gql<{ contactVehicles: Vehicle[] }>(`query Vehicles($c: ID!) { contactVehicles(contactId: $c) { ${FIELDS} } }`, { c: contactId })).contactVehicles;
}

export async function searchVehicleCustomers(search: string) {
  return (await gql<{ vehicleCustomers: VehicleCustomer[] }>(`query VehicleCustomers($s: String) { vehicleCustomers(search: $s) { id name waId } }`, { s: search })).vehicleCustomers;
}

export async function addVehicle(input: VehicleInput) {
  return (await gql<{ addVehicle: Vehicle }>(`mutation AddVehicle($i: VehicleInput!) { addVehicle(input: $i) { ${FIELDS} } }`, { i: input })).addVehicle;
}

export async function deleteVehicle(id: string) {
  return (await gql<{ deleteVehicle: boolean }>(`mutation DeleteVehicle($id: ID!) { deleteVehicle(id: $id) }`, { id })).deleteVehicle;
}

// "Toyota Land Cruiser 2022" from what's filled in; '' when none is
export const vehicleTitle = (v: Pick<Vehicle, 'make' | 'model' | 'year'>) => [v.make, v.model, v.year].filter(Boolean).join(' ');
