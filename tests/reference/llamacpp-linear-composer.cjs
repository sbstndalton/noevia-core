// Test-only mechanical composer extracted from HOST SHA256 be9d97fdbafca62106352eb5383a620ef53ba1a0bb99e36b8f1fd4253069a96d.
// Extracted payload SHA256 90997153b90b0a838899a14f46e49d203030c912441b617898b057c72897e963; no estimator body.
'use strict';
const apply=Reflect.apply;
function privateArgs(array, transform) {
  const result = { __proto__: null, length: 0 };
  let length = 0;
  for (let index = 0; index < array.length; index++) result[length++] = transform(array[index], index);
  result.length = length;
  return result;
}
function linearBinary(operator, left, right, fault) {
  switch (operator) {
    case '+': return (a,b,c) => left(a,b,c) + right(a,b,c);
    case '-': return (a,b,c) => left(a,b,c) - right(a,b,c);
    case '*': return (a,b,c) => left(a,b,c) * right(a,b,c);
    case '/': return (a,b,c) => left(a,b,c) / right(a,b,c);
    case '%': return (a,b,c) => left(a,b,c) % right(a,b,c);
    case '**': return (a,b,c) => left(a,b,c) ** right(a,b,c);
    case '>': return (a,b,c) => left(a,b,c) > right(a,b,c);
    case '>=': return (a,b,c) => left(a,b,c) >= right(a,b,c);
    case '<': return (a,b,c) => left(a,b,c) < right(a,b,c);
    case '<=': return (a,b,c) => left(a,b,c) <= right(a,b,c);
    case '===': return (a,b,c) => left(a,b,c) === right(a,b,c);
    case '!==': return (a,b,c) => left(a,b,c) !== right(a,b,c);
    case '==': return (a,b,c) => left(a,b,c) == right(a,b,c); // eslint-disable-line eqeqeq
    case '!=': return (a,b,c) => left(a,b,c) != right(a,b,c); // eslint-disable-line eqeqeq
    default: throw fault();
  }
}
function linearUnary(operator, value, fault) {
  switch (operator) {
    case '!': return (a,b,c) => !value(a,b,c);
    case '+': return (a,b,c) => +value(a,b,c);
    case '-': return (a,b,c) => -value(a,b,c);
    case 'typeof': return (a,b,c) => typeof value(a,b,c);
    case 'void': return (a,b,c) => void value(a,b,c);
    default: throw fault();
  }
}
function linearTree(tree, environment, fault) {
  const op=tree[0], data=tree[1];
  switch (op) {
    case 'arg':
      if (data === 0) return a => a;
      if (data === 1) return (a,b) => b;
      if (data === 2) return (a,b,c) => c;
      throw fault();
    case 'undefined': return () => undefined;
    case 'literal': return () => data;
    case 'load': return () => environment[data];
    case 'binary': return linearBinary(data, linearTree(tree[2], environment, fault), linearTree(tree[3], environment, fault), fault);
    case 'unary': return linearUnary(data, linearTree(tree[2], environment, fault), fault);
    case 'get': {
      const object = linearTree(data, environment, fault), key = linearTree(tree[2], environment, fault);
      return (a,b,c) => object(a,b,c)[key(a,b,c)];
    }
    case 'method': {
      const object = linearTree(data, environment, fault), key = linearTree(tree[2], environment, fault);
      const arguments_ = privateArgs(tree[3],argument => linearTree(argument, environment, fault));
      return (a,b,c) => {
        const receiver = object(a,b,c), fn = receiver[key(a,b,c)];
        return apply(fn, receiver, privateArgs(arguments_,argument => argument(a,b,c)));
      };
    }
    case 'call': {
      const fn = linearTree(data, environment, fault);
      const arguments_ = privateArgs(tree[2],argument => linearTree(argument, environment, fault));
      return (a,b,c) => {
        const callee = fn(a,b,c);
        return apply(callee, undefined, privateArgs(arguments_,argument => argument(a,b,c)));
      };
    }
    default: throw fault();
  }
}




module.exports={build:(tree,environment)=>linearTree(tree,environment,()=>new Error('diagnostic IR fault'))};
