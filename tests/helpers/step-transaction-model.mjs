// Isolated behavioral model of the SQL transaction, NOT a PostgreSQL emulator.
// It checks ordering invariants and injected rollback/concurrency scenarios.
// Passing these tests does not establish that the unapplied migration runs in PG.
export function failure(code, message = "SECRET: simulated database failure") {
  return { code, message };
}

export function applyStepTransaction(rows, input, options = {}) {
  if (options.signedOut || options.nonAdmin || options.profileMissing || options.profileError) throw failure("42501");
  const parent = rows.chains.find(chain => chain.id === input.p_chain_id);
  if (!parent) throw failure("P0002");
  if (parent.slug === "caption-arena-default") throw failure("42501");
  const working = structuredClone(rows.steps.filter(step => step.chain_id === parent.id)).sort((a, b) => a.step_order - b.step_order);
  const expected = input.p_expected_order;
  if (!Array.isArray(expected) || expected.some(item => !item || typeof item.id !== "string" || !Number.isInteger(item.step_order) || item.step_order < 1) || new Set(expected.map(item => item.id)).size !== expected.length || new Set(expected.map(item => item.step_order)).size !== expected.length) throw failure("22023");
  if (JSON.stringify(expected) !== JSON.stringify(working.map(({ id, step_order }) => ({ id, step_order })))) throw failure("40001");
  const operation = input.p_operation;
  if (!["create", "update", "delete", "move_up", "move_down", "move_to"].includes(operation)) throw failure("22023");
  let selected = working.find(step => step.id === input.p_step_id);
  if (operation !== "create" && !selected) throw failure("P0002");
  if (["create", "update"].includes(operation) && (!input.p_name?.trim() || !input.p_prompt_template?.trim())) throw failure("22023");
  if (["update", "delete"].includes(operation) && (selected.name !== input.p_expected_name || selected.prompt_template !== input.p_expected_template)) throw failure("40001");
  const inject = point => { if (options.failAt === point) throw failure("XX000"); };
  const validatePositions = () => {
    const positions = working.map(step => step.step_order);
    if (positions.some(value => !Number.isInteger(value) || value <= 0 || value > 2147483647) || new Set(positions).size !== positions.length) throw failure("23505");
  };
  if (operation === "update") {
    selected.name = input.p_name.trim(); selected.prompt_template = input.p_prompt_template;
  } else {
    if (operation === "delete") { working.splice(working.indexOf(selected), 1); inject("after-delete"); }
    else if (operation === "move_up" || operation === "move_down") {
      const index = working.indexOf(selected), other = index + (operation === "move_up" ? -1 : 1);
      if (other < 0 || other >= working.length) throw failure("22023");
      [working[index], working[other]] = [working[other], working[index]];
    } else if (operation === "move_to") {
      if (!Number.isInteger(input.p_destination) || input.p_destination < 1 || input.p_destination > working.length) throw failure("22023");
      working.splice(working.indexOf(selected), 1);
      working.splice(input.p_destination - 1, 0, selected);
    }
    const count = working.length + (operation === "create" ? 1 : 0);
    const occupied = new Set(working.map(step => step.step_order));
    const temporary = [];
    for (let position = count + 1; position <= count * 3 && temporary.length < count; position++) if (!occupied.has(position)) temporary.push(position);
    if (temporary.length !== count) throw failure("40001");
    if (operation === "create") {
      selected = { id: options.newId, chain_id: parent.id, name: input.p_name.trim(), prompt_template: input.p_prompt_template, step_order: temporary[count - 1] };
      working.push(selected); validatePositions(); inject("after-insert");
    }
    working.forEach((step, index) => {
      step.step_order = temporary[index]; validatePositions(); inject(`temporary:${index + 1}`);
    });
    working.forEach((step, index) => {
      step.step_order = index + 1; validatePositions(); inject(`final:${index + 1}`);
    });
  }
  // Commit only this chain. Any exception leaves the original rows unchanged.
  rows.steps = [...rows.steps.filter(step => step.chain_id !== parent.id), ...working];
  return selected.id;
}
