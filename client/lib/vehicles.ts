import { gql } from './api';

// A customer's vehicles (chat header car button, contact profile "Add Vehicle"). Dates are yyyy-mm-dd.
export type Vehicle = {
  id: string;
  contactId: string;
  plateNumber: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  registrationDate: string | null;
  lastServiceDate: string | null;
  tireSize1: string;
  tireSize2: string | null;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
};
// What the form sends. lastServiceDate is no longer on the form: left out, so editing keeps a saved one
export type VehicleDetails = Pick<Vehicle, 'plateNumber' | 'make' | 'model' | 'year' | 'registrationDate' | 'tireSize1' | 'tireSize2' | 'remarks'>;
export type VehicleInput = VehicleDetails & { contactId: string };
export type VehicleCustomer = { id: string; name: string | null; waId: string };

// Window event relayed from the socket's contact:vehicles ({ contactId }): open vehicle lists reload
export const VEHICLES_EVENT = 'crm:contact-vehicles';

const FIELDS = 'id contactId plateNumber make model year registrationDate lastServiceDate tireSize1 tireSize2 remarks createdAt updatedAt';

export async function listVehicles(contactId: string) {
  return (await gql<{ contactVehicles: Vehicle[] }>(`query ContactVehicles($c: ID!) { contactVehicles(contactId: $c) { ${FIELDS} } }`, { c: contactId })).contactVehicles;
}

export async function searchVehicleCustomers(search: string) {
  const query = `query VehicleCustomers($s: String) { vehicleCustomers(search: $s) { id name waId } }`;
  return (await gql<{ vehicleCustomers: VehicleCustomer[] }>(query, { s: search.trim() || null })).vehicleCustomers;
}

export async function addVehicle(input: VehicleInput) {
  const query = `mutation AddVehicle($input: VehicleInput!) { addVehicle(input: $input) { ${FIELDS} } }`;
  return (await gql<{ addVehicle: Vehicle }>(query, { input })).addVehicle;
}

export async function updateVehicle(id: string, input: VehicleDetails) {
  const query = `mutation UpdateVehicle($id: ID!, $input: UpdateVehicleInput!) { updateVehicle(id: $id, input: $input) { ${FIELDS} } }`;
  return (await gql<{ updateVehicle: Vehicle }>(query, { id, input })).updateVehicle;
}

export async function deleteVehicle(id: string) {
  await gql(`mutation DeleteVehicle($id: ID!) { deleteVehicle(id: $id) }`, { id });
}

// "Toyota Land Cruiser 2022"; "Vehicle" when make, model and year are all left empty
export const vehicleTitle = (v: Pick<Vehicle, 'make' | 'model' | 'year'>) => [v.make, v.model, v.year].filter(Boolean).join(' ') || 'Vehicle';

// Make → Model → Year dropdowns: the Wheel API's catalog plus the ones added with "+ Add New …" (custom: kept by the
// server in server/config/vehicle-catalog.json). Everything goes by name, as saved on the vehicle.
export type CatalogOption = { slug: string | null; name: string; logo: string | null; custom: boolean };
// error: the Wheel API couldn't be reached (the added ones are still listed)
export type CatalogList = { options: CatalogOption[]; error: string | null };
// years: empty when the catalog has none for the model (the form then offers every year)
export type YearList = { years: number[]; error: string | null };

const OPTION = 'slug name logo custom';
const catalogCache = new Map<string, Promise<unknown>>();
const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
// Kept for the session (the lists hardly change); a failed load is forgotten so it can be tried again
function catalog<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = catalogCache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    p.catch(() => catalogCache.delete(key));
    catalogCache.set(key, p);
  }
  return p;
}

export const vehicleMakes = () =>
  catalog('makes', async () => (await gql<{ vehicleMakes: CatalogList }>(`query VehicleMakes { vehicleMakes { options { ${OPTION} } error } }`)).vehicleMakes);

export const vehicleModels = (make: string) =>
  catalog(`models|${nameKey(make)}`, async () =>
    (await gql<{ vehicleModels: CatalogList }>(`query VehicleModels($m: String!) { vehicleModels(make: $m) { options { ${OPTION} } error } }`, { m: make })).vehicleModels,
  );

export const vehicleYears = (make: string, model: string) =>
  catalog(`years|${nameKey(make)}|${nameKey(model)}`, async () =>
    (await gql<{ vehicleYears: YearList }>(`query VehicleYears($m: String!, $o: String!) { vehicleYears(make: $m, model: $o) { years error } }`, { m: make, o: model }))
      .vehicleYears,
  );

// "+ Add New …": saved by the server (errors: BAD_USER_INPUT, DUPLICATE). The list it belongs to is reloaded next time.
export async function addVehicleMake(name: string) {
  const query = `mutation AddVehicleMake($n: String!) { addVehicleMake(name: $n) { ${OPTION} } }`;
  const added = (await gql<{ addVehicleMake: CatalogOption }>(query, { n: name })).addVehicleMake;
  catalogCache.delete('makes');
  return added;
}

export async function addVehicleModel(make: string, name: string) {
  const query = `mutation AddVehicleModel($m: String!, $n: String!) { addVehicleModel(make: $m, name: $n) { ${OPTION} } }`;
  const added = (await gql<{ addVehicleModel: CatalogOption }>(query, { m: make, n: name })).addVehicleModel;
  catalogCache.delete(`models|${nameKey(make)}`);
  return added;
}

export async function addVehicleYear(make: string, model: string, year: number) {
  const query = `mutation AddVehicleYear($m: String!, $o: String!, $y: Int!) { addVehicleYear(make: $m, model: $o, year: $y) }`;
  const added = (await gql<{ addVehicleYear: number }>(query, { m: make, o: model, y: year })).addVehicleYear;
  catalogCache.delete(`years|${nameKey(make)}|${nameKey(model)}`);
  return added;
}
