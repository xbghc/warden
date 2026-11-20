const orders = [
  { id: 'A-1042', customer: 'Lin Mei', status: 'Paid', total: 128.5 },
  { id: 'A-1043', customer: 'Jonas Weber', status: 'Pending', total: 64.0 },
  { id: 'A-1044', customer: 'Aiko Tanaka', status: 'Shipped', total: 310.2 },
  { id: 'A-1045', customer: 'Omar Haddad', status: 'Pending', total: 42.75 },
  { id: 'A-1046', customer: 'Sofia Rossi', status: 'Paid', total: 89.9 },
];

function render() {
  document.getElementById('orders').innerHTML = orders
    .map((order) => `<tr><td>${order.id}</td><td>${order.customer}</td><td>${order.status}</td><td class="amount">${order.total.toFixed(2)}</td></tr>`)
    .join('');
}

render();
