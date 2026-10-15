// Realistic, fictional restaurant data for the developer "Auto rellenar" tool. Nothing here is a real person, a real
// customer or a real business; prices are plausible CLP values. Kept as plain data so generators and tests share it.
// All values respect the limits enforced by the forms and the backend DTOs (tag <= 40, ingredient <= 80,
// <= 20 ingredients, add-on name <= 60, price integer 0..100000, <= 15 add-ons, table name <= 40).

export const PRODUCT_PRESETS = [
  {
    category: 'Hamburguesas',
    name: 'Hamburguesa Campestre',
    description: 'Medallón de carne de 180 g con queso de campo, cebolla caramelizada, rúcula y mayonesa de ajo asado en pan brioche.',
    price: 8900,
    tag: 'Más pedido',
    ingredients: ['Pan brioche', 'Medallón de carne 180 g', 'Queso de campo', 'Cebolla caramelizada', 'Rúcula', 'Mayonesa de ajo asado'],
    removable: ['Cebolla caramelizada', 'Rúcula', 'Mayonesa de ajo asado'],
    addOns: [['Queso extra', 1200], ['Tocino crocante', 1500], ['Huevo frito', 1000], ['Doble carne', 2800]],
  },
  {
    category: 'Hamburguesas',
    name: 'Clásica BBQ',
    description: 'Carne, cheddar, tocino y salsa barbacoa ahumada.',
    price: 7900,
    tag: 'Nuevo',
    ingredients: ['Pan brioche', 'Carne 150 g', 'Queso cheddar', 'Tocino', 'Salsa barbacoa', 'Pepinillos'],
    removable: ['Pepinillos', 'Salsa barbacoa'],
    addOns: [['Aros de cebolla', 1800], ['Palta', 1300]],
  },
  {
    category: 'Pizzas',
    name: 'Pizza Margarita de Masa Madre',
    description: 'Masa madre de 48 horas, salsa de tomate italiano, mozzarella fresca y albahaca.',
    price: 10900,
    tag: 'Chef',
    ingredients: ['Masa madre', 'Salsa de tomate italiano', 'Mozzarella fresca', 'Albahaca', 'Aceite de oliva'],
    removable: ['Albahaca'],
    addOns: [['Pepperoni', 1800], ['Champiñones', 1200], ['Borde de queso', 1500]],
  },
  {
    category: 'Pizzas',
    name: 'Pizza Cuatro Quesos',
    description: 'Mozzarella, gorgonzola, parmesano y queso de cabra.',
    price: 12500,
    tag: '',
    ingredients: ['Masa madre', 'Mozzarella', 'Gorgonzola', 'Parmesano', 'Queso de cabra'],
    removable: ['Gorgonzola', 'Queso de cabra'],
    addOns: [['Miel de ulmo', 900]],
  },
  {
    category: 'Pastas',
    name: 'Pasta Pesto',
    description: 'Tagliatelle frescos con pesto de albahaca y piñones, tomates cherry y parmesano.',
    price: 9500,
    tag: 'Vegetariano',
    ingredients: ['Tagliatelle', 'Pesto de albahaca', 'Piñones', 'Tomates cherry', 'Parmesano'],
    removable: ['Piñones', 'Parmesano'],
    addOns: [['Pollo grillado', 2200], ['Camarones salteados', 3500]],
  },
  {
    category: 'Pastas',
    name: 'Ravioles de Zapallo',
    description: 'Ravioles rellenos de zapallo asado en salsa de mantequilla y salvia.',
    price: 10200,
    tag: '',
    ingredients: ['Ravioles de zapallo', 'Mantequilla', 'Salvia', 'Nueces', 'Parmesano'],
    removable: ['Nueces'],
    addOns: [],
  },
  {
    category: 'Ensaladas',
    name: 'Ensalada Cítrica',
    description: 'Mix de hojas verdes, palta, pomelo rosado, almendras y vinagreta de naranja.',
    price: 6900,
    tag: 'Sin gluten',
    ingredients: ['Mix de hojas verdes', 'Palta', 'Pomelo rosado', 'Almendras', 'Vinagreta de naranja'],
    removable: ['Almendras', 'Pomelo rosado'],
    addOns: [['Pollo grillado', 2200], ['Quínoa', 1000]],
  },
  {
    category: 'Bebidas',
    name: 'Limonada Menta Jengibre',
    description: 'Limón de pica exprimido al momento con menta fresca y jengibre.',
    price: 3900,
    tag: 'Refrescante',
    ingredients: ['Limón de pica', 'Menta', 'Jengibre', 'Hielo'],
    removable: ['Jengibre', 'Hielo'],
    addOns: [['Botella 1 L', 2500]],
  },
  {
    category: 'Bebidas',
    name: 'Jugo Natural de Frutilla',
    description: 'Frutillas de temporada licuadas con agua o leche.',
    price: 3500,
    tag: '',
    ingredients: ['Frutilla', 'Agua o leche', 'Azúcar'],
    removable: ['Azúcar'],
    addOns: [],
  },
  {
    category: 'Cocteles',
    name: 'Mojito de Maracuyá',
    description: 'Ron blanco, maracuyá, menta y soda.',
    price: 6200,
    tag: 'Solo mayores de 18',
    ingredients: ['Ron blanco', 'Pulpa de maracuyá', 'Menta', 'Soda', 'Azúcar'],
    removable: ['Azúcar'],
    addOns: [['Trago doble', 2500]],
  },
  {
    category: 'Postres',
    name: 'Brownie con Helado',
    description: 'Brownie tibio de chocolate semiamargo con helado de vainilla y salsa de caramelo salado.',
    price: 5200,
    tag: 'Para compartir',
    ingredients: ['Brownie de chocolate', 'Helado de vainilla', 'Caramelo salado', 'Nueces'],
    removable: ['Nueces', 'Caramelo salado'],
    addOns: [['Bola extra de helado', 1200]],
  },
  {
    category: 'Para compartir',
    name: 'Papas Rústicas con Alioli',
    description: 'Papas con cáscara al horno de barro, romero y alioli casero.',
    price: 4800,
    tag: '',
    ingredients: ['Papas', 'Romero', 'Sal de mar', 'Alioli'],
    removable: ['Romero', 'Alioli'],
    addOns: [['Salsa de queso', 900], ['Tocino picado', 1100]],
  },
]

export const CATEGORY_PRESETS = [
  'Hamburguesas',
  'Pizzas',
  'Pastas',
  'Ensaladas',
  'Bebidas',
  'Cocteles',
  'Postres',
  'Para compartir',
  'Desayunos',
  'Menú infantil',
  'Sandwiches',
  'Parrilla',
]

export const TABLE_PRESETS = ['Terraza', 'Mesa', 'Barra', 'Salón', 'Patio', 'Ventana']

// A SYNTHETIC restaurant used to fill the EMPTY fields of the business form. Everything is visibly demo data so it
// can never be mistaken for a real commerce, address or person: names and streets carry the word "Demo", the city is
// "Ciudad Demo", and phones are "DEMO"-prefixed placeholders made of zeros (not a dialable number in any country),
// in a short and a long variant so the field's length and format handling can still be exercised.
// No colours or logo are ever generated.
export const BUSINESS_PRESETS = [
  {
    address: 'Av. Los Aromos Demo 1470, Local 3, Ciudad Demo',
    phone: 'DEMO +00 0000 0000',
    hours: 'Lun-Jue 12:30-23:00 · Vie-Sáb 12:30-00:30 · Dom 12:30-21:00',
  },
  {
    address: 'Calle Mercado Demo 285, Ciudad Demo',
    phone: 'DEMO 0000 0000',
    hours: 'Mar-Dom 13:00-23:30 · Lunes cerrado',
  },
  {
    address: 'Camino Demo 90, Sector Norte, Ciudad Demo',
    phone: 'DEMO +00 00 0000 0000 · anexo 000',
    hours: 'Todos los días 12:00-22:00',
  },
]

export const BUSINESS_NAME_PRESETS = ['Fogón Demo', 'Parrilla Demo', 'Bistró Olivo Demo', 'Brasas Demo']
