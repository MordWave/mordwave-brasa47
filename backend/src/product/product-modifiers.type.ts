export interface ProductAddOn {
  name: string;
  price: number;
}

export interface ProductModifiers {
  remove?: string[];
  add?: ProductAddOn[];
}
