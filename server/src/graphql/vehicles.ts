import { addVehicle, deleteVehicle, listVehicles, searchVehicleCustomers, updateVehicle } from '../services/vehicles.js';
import { addMake, addModel, addYear, listMakes, listModels, listYears } from '../services/customVehicles.js';
import { vehicleCatalogEnabled } from '../services/vehicleCatalog.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "A customer's vehicle (one CRM contact has any number)"
  type Vehicle {
    id: ID!
    contactId: ID!
    "Uppercase, e.g. DUBAI A 12345"
    plateNumber: String
    make: String
    model: String
    year: Int
    "yyyy-mm-dd"
    registrationDate: String
    "yyyy-mm-dd: last tyre purchase or service"
    lastServiceDate: String
    tireSize1: String!
    tireSize2: String
    "Free-text notes about this vehicle"
    remarks: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  "A contact offered by the CRM Customer picker"
  type VehicleCustomer {
    id: ID!
    name: String
    waId: String!
  }

  "A make or model for the vehicle form's dropdowns: from the Wheel API, or added with + Add New (custom)"
  type VehicleCatalogOption {
    "Wheel API slug; null for an added one"
    slug: String
    name: String!
    logo: String
    "Added in the app (server/config/vehicle-catalog.json)"
    custom: Boolean!
  }

  "A dropdown's options; error: the Wheel API couldn't be reached (the added ones are still listed)"
  type VehicleCatalogList {
    options: [VehicleCatalogOption!]!
    error: String
  }

  "A model's years, newest first; empty when the catalog has none for it (the form then offers every year)"
  type VehicleYearList {
    years: [Int!]!
    error: String
  }

  input VehicleInput {
    contactId: ID!
    plateNumber: String
    make: String
    model: String
    year: Int
    "yyyy-mm-dd, not in the future"
    registrationDate: String
    "yyyy-mm-dd, not in the future"
    lastServiceDate: String
    tireSize1: String!
    tireSize2: String
    remarks: String
  }

  "Edit: only the fields sent change; null clears an optional one"
  input UpdateVehicleInput {
    plateNumber: String
    make: String
    model: String
    year: Int
    registrationDate: String
    lastServiceDate: String
    tireSize1: String
    tireSize2: String
    remarks: String
  }

  extend type Query {
    "This contact's vehicles, newest first"
    contactVehicles(contactId: ID!): [Vehicle!]!
    "Up to 20 contacts matching name, first/last name or WhatsApp number digits"
    vehicleCustomers(search: String): [VehicleCustomer!]!
    "Whether the Make / Model / Year lists are set up (WHEEL_API_KEY); false: the form takes typed values"
    vehicleCatalogEnabled: Boolean!
    "Every vehicle make (Wheel API + added), A-Z"
    vehicleMakes: VehicleCatalogList!
    "A make's models (Wheel API + added), A-Z. make: its name"
    vehicleModels(make: String!): VehicleCatalogList!
    "A model's production years (Wheel API + added). make, model: their names"
    vehicleYears(make: String!, model: String!): VehicleYearList!
  }

  extend type Mutation {
    addVehicle(input: VehicleInput!): Vehicle!
    updateVehicle(id: ID!, input: UpdateVehicleInput!): Vehicle!
    "Soft delete"
    deleteVehicle(id: ID!): Boolean!
    "+ Add New Make: saved to server/config/vehicle-catalog.json. Errors: BAD_USER_INPUT, DUPLICATE (already listed)"
    addVehicleMake(name: String!): VehicleCatalogOption!
    "+ Add New Model for a make (by name)"
    addVehicleModel(make: String!, name: String!): VehicleCatalogOption!
    "+ Add New Year for a make and model (by name)"
    addVehicleYear(make: String!, model: String!, year: Int!): Int!
  }
`;

export const resolvers = {
  Query: {
    contactVehicles: authed(({ contactId }: { contactId: string }, auth) => listVehicles(auth, contactId)),
    vehicleCustomers: authed(({ search }: { search?: string | null }, auth) => searchVehicleCustomers(auth, search)),
    vehicleCatalogEnabled: authed(async () => vehicleCatalogEnabled()),
    vehicleMakes: authed(() => listMakes()),
    vehicleModels: authed(({ make }: { make: string }) => listModels(make)),
    vehicleYears: authed(({ make, model }: { make: string; model: string }) => listYears(make, model)),
  },
  Mutation: {
    addVehicle: authed(({ input }: { input: unknown }, auth) => addVehicle(auth, input)),
    updateVehicle: authed(({ id, input }: { id: string; input: unknown }, auth) => updateVehicle(auth, id, input)),
    deleteVehicle: authed(({ id }: { id: string }, auth) => deleteVehicle(auth, id)),
    addVehicleMake: authed(({ name }: { name: string }) => addMake(name)),
    addVehicleModel: authed(({ make, name }: { make: string; name: string }) => addModel(make, name)),
    addVehicleYear: authed(({ make, model, year }: { make: string; model: string; year: number }) => addYear(make, model, year)),
  },
};
