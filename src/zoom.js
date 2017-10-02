import {dispatch} from "d3-dispatch";
import {dragDisable, dragEnable} from "d3-drag";
import {interpolateNumber} from "d3-interpolate";
import {event, customEvent, select, mouse, touch} from "d3-selection";
import {interrupt} from "d3-transition";
import constant from "./constant";
import ZoomEvent from "./event";
import {Transform, identity} from "./transform";
import noevent, {nopropagation} from "./noevent";

// Ignore right-click, since that should open the context menu.
function defaultFilter() {
  return !event.button;
}

function defaultExtent() {
  var e = this, w, h;
  if (e instanceof SVGElement) {
    e = e.ownerSVGElement || e;
    w = e.width.baseVal.value;
    h = e.height.baseVal.value;
  } else {
    if (e && e.clientWidth && e.clientHeight) {
      w = e.clientWidth;
      h = e.clientHeight;
    } else {
      throw 'd3-xyzoom failed to constrain scales because extent is undefined.';
    }
  }
  return [[0, 0], [w, h]];
}

function defaultTransform() {
  return this.__zoom || identity;
}

function defaultWheelDelta() {
  return -event.deltaY * (event.deltaMode ? 120 : 1) / 500;
}

function touchable() {
    return "ontouchstart" in this;
}

export default function() {
  var filter = defaultFilter,
    extent = defaultExtent,
    wheelDelta = defaultWheelDelta,
    kx0 = 0,
    ky0 = 0,
    kx0u = 0, // Min scale extent defined by user, can be overridden by kx0 and ky0 defined in constrainScaleExtent
    ky0u = 0,
    kx1 = Infinity,
    ky1 = Infinity,
    rx = 1,
    ry = 1,
    x0 = -Infinity,
    x1 = Infinity,
    y0 = -Infinity,
    y1 = Infinity,
    duration = 250,
    interpolate = interpolateNumber,
    gestures = [],
    listeners = dispatch("start", "zoom", "end"),
    touchstarting,
    touchending,
    touchDelay = 500,
    wheelDelay = 150,
    clickDistance2 = 0;

  function zoom(selection) {
    selection
      .property("__zoom", defaultTransform)
      .on("wheel.zoom", wheeled)
      .on("mousedown.zoom", mousedowned)
      .on("dblclick.zoom", dblclicked)
      .filter(touchable)
        .on("touchstart.zoom", touchstarted)
        .on("touchmove.zoom", touchmoved)
        .on("touchend.zoom touchcancel.zoom", touchended)
        .style("touch-action", "none")
        .style("-webkit-tap-highlight-color", "rgba(0,0,0,0)");
  }

  zoom.transform = function(collection, transform) {
    var selection = collection.selection ? collection.selection() : collection;
    selection.property("__zoom", defaultTransform);
    if (collection !== selection) {
      schedule(collection, transform);
    } else {
      selection.interrupt().each(function() {
        gesture(this, arguments)
          .start()
          .zoom(null, typeof transform === "function" ? transform.apply(this, arguments) : transform)
          .end();
      });
    }
  };

  zoom.scaleBy = function(selection, kx, ky) {
    zoom.scaleTo(selection, function() {
      var k0 = this.__zoom.kx,
        k1 = typeof kx === "function" ? kx.apply(this, arguments) : kx;
      return k0 * k1;
    }, function() {
      var k0 = this.__zoom.ky,
        k1 = typeof ky === "function" ? ky.apply(this, arguments) : ky;
      return k0 * k1;
    });
  };

  zoom.scaleTo = function(selection, kx, ky) {
    zoom.transform(selection, function() {
      var e = extent.apply(this, arguments),
        t0 = this.__zoom,
        p0 = centroid(e),
        p1 = t0.invert(p0),
        kx1 = typeof kx === "function" ? kx.apply(this, arguments) : kx,
        ky1 = typeof ky === "function" ? ky.apply(this, arguments) : ky;
      return constrain(translate(scale(t0, kx1, ky1), p0, p1), e);
    });
  };

  zoom.translateBy = function(selection, x, y) {
    zoom.transform(selection, function() {
      return constrain(this.__zoom.translate(
        typeof x === "function" ? x.apply(this, arguments) : x,
        typeof y === "function" ? y.apply(this, arguments) : y
      ), extent.apply(this, arguments));
    });
  };

  function scale(transform, kx, ky) {
    kx = Math.max(kx0, Math.min(kx1, kx));
    ky = Math.max(ky0, Math.min(ky1, ky));
    return (kx === transform.kx && ky === transform.ky) ? transform : new Transform(transform.x, transform.y, kx, ky);
  }

  function translate(transform, p0, p1) {
    var x = p0[0] - p1[0] * transform.kx, y = p0[1] - p1[1] * transform.ky;
    return x === transform.x && y === transform.y ? transform : new Transform(x, y, transform.kx, transform.ky);
  }

  function constrain(transform, extent) {
    var dx0 = transform.invertX(extent[0][0]) - x0,
      dx1 = transform.invertX(extent[1][0]) - x1,
      dy0 = transform.invertY(extent[0][1]) - y0,
      dy1 = transform.invertY(extent[1][1]) - y1;
    return transform.translate(
      dx1 > dx0 ? (dx0 + dx1) / 2 : Math.min(0, dx0) || Math.max(0, dx1),
      dy1 > dy0 ? (dy0 + dy1) / 2 : Math.min(0, dy0) || Math.max(0, dy1)
    );
  }

  function centroid(extent) {
    return [(+extent[0][0] + +extent[1][0]) / 2, (+extent[0][1] + +extent[1][1]) / 2];
  }

  function schedule(transition, transform) {
    transition
      .on("start.zoom", function() { gesture(this, arguments).start(); })
      .on("interrupt.zoom end.zoom", function() { gesture(this, arguments).end(); })
      .tween("zoom", function() {
        var that = this,
          args = arguments,
          g = gesture(that, args),
          a = that.__zoom,
          b = typeof transform === "function" ? transform.apply(that, args) : transform;
        var txi = interpolate(a.x, b.x);
        var tyi = interpolate(a.y, b.y);
        var kxi = interpolate(a.kx, b.kx);
        var kyi = interpolate(a.ky, b.ky);
        return function(t) {
          if (t === 1) t = b; // Avoid rounding error on end.
          else {
            t = new Transform(txi(t), tyi(t), kxi(t), kyi(t));
          }
          g.zoom(null, t);
        };
      });
  }

  function gesture(that, args) {
    for (var i = 0, n = gestures.length, g; i < n; ++i) {
      if ((g = gestures[i]).that === that) {
        return g;
      }
    }
    return new Gesture(that, args);
  }

  function Gesture(that, args) {
    this.that = that;
    this.args = args;
    this.index = -1;
    this.active = 0;
    this.extent = extent.apply(that, args);
  }

  Gesture.prototype = {
    start: function() {
      if (++this.active === 1) {
        this.index = gestures.push(this) - 1;
        this.emit("start");
      }
      return this;
    },
    zoom: function(key, transform) {
      if (this.mouse && key !== "mouse") this.mouse[1] = transform.invert(this.mouse[0]);
      if (this.touch0 && key !== "touch") this.touch0[1] = transform.invert(this.touch0[0]);
      if (this.touch1 && key !== "touch") this.touch1[1] = transform.invert(this.touch1[0]);
      this.that.__zoom = transform;
      this.emit("zoom");
      return this;
    },
    end: function() {
      if (--this.active === 0) {
        gestures.splice(this.index, 1);
        this.index = -1;
        this.emit("end");
      }
      return this;
    },
    emit: function(type) {
      customEvent(new ZoomEvent(zoom, type, this.that.__zoom), listeners.apply, listeners, [type, this.that, this.args]);
    }
  };

  function wheeled() {
    if (!filter.apply(this, arguments)) return;
    var g = gesture(this, arguments);
    var t = this.__zoom;
    var kx = Math.max(kx0, Math.min(kx1, t.kx * (1 + rx * (-1 + Math.pow(2, wheelDelta.apply(this, arguments))))));
    var ky = Math.max(ky0, Math.min(ky1, t.ky * (1 + ry * (-1 + Math.pow(2, wheelDelta.apply(this, arguments))))));
    var p = mouse(this);

    // If a scale factor has reached scale extend, sync its value with the other one
    if (t.kx === kx0) {
      kx = ky >= kx0 ? kx : kx0;
    }
    if (t.kx === kx1) {
      kx = ky <= kx1 ? kx : kx1;
    }
    if (t.ky === ky0) {
      ky = kx >= ky0 ? ky : ky0;
    }
    if (t.ky === ky1) {
      ky = kx <= ky1 ? ky : ky1;
    }

    // If the mouse is in the same location as before, reuse it.
    // If there were recent wheel events, reset the wheel idle timeout.
    if (g.wheel) {
      if (g.mouse[0][0] !== p[0] || g.mouse[0][1] !== p[1]) {
        g.mouse[1] = t.invert(g.mouse[0] = p);
      }
      clearTimeout(g.wheel);
    }


    // If this wheel event won’t trigger a transform change, ignore it.
    else if (t.kx === ky && t.ky === kx) return;

    // Otherwise, capture the mouse point and location at the start.
    else {
      g.mouse = [p, t.invert(p)];
      interrupt(this);
      g.start();
    }

    noevent();
    g.wheel = setTimeout(wheelidled, wheelDelay);
    g.zoom("mouse", constrain(translate(scale(t, kx, ky), g.mouse[0], g.mouse[1]), g.extent));

    function wheelidled() {
      g.wheel = null;
      g.end();
    }
  }

  function mousedowned() {
    if (touchending || !filter.apply(this, arguments)) return;
    var g = gesture(this, arguments),
      v = select(event.view).on("mousemove.zoom", mousemoved, true).on("mouseup.zoom", mouseupped, true),
      p = mouse(this),
      x0 = event.clientX,
      y0 = event.clientY;

    dragDisable(event.view);
    nopropagation();
    g.mouse = [p, this.__zoom.invert(p)];
    interrupt(this);
    g.start();

    function mousemoved() {
      noevent();
      if (!g.moved) {
        var dx = event.clientX - x0, dy = event.clientY - y0;
        g.moved = g.moved || dx * dx + dy * dy > clickDistance2;
      }
      g.zoom("mouse", constrain(translate(g.that.__zoom, g.mouse[0] = mouse(g.that), g.mouse[1]), g.extent));
    }

    function mouseupped() {
      v.on("mousemove.zoom mouseup.zoom", null);
      dragEnable(event.view, g.moved);
      noevent();
      g.end();
    }
  }

  function dblclicked() {
    if (!filter.apply(this, arguments)) return;
    var t0 = this.__zoom,
      p0 = mouse(this),
      p1 = t0.invert(p0),
      kx1 = t0.kx * (1 + rx * (-1 + (event.shiftKey ? 0.5 : 2))),
      ky1 = t0.ky * (1 + ry * (-1 + (event.shiftKey ? 0.5 : 2))),
      t1 = constrain(translate(scale(t0, kx1, ky1), p0, p1), extent.apply(this, arguments));

    noevent();
    if (duration > 0) select(this).transition().duration(duration).call(schedule, t1, p0);
    else select(this).call(zoom.transform, t1);
  }

  function touchstarted() {
    if (!filter.apply(this, arguments)) return;
    var g = gesture(this, arguments),
      touches = event.changedTouches,
      n = touches.length, i, t, p;

    nopropagation();
    for (i = 0; i < n; ++i) {
      t = touches[i], p = touch(this, touches, t.identifier);
      p = [p, this.__zoom.invert(p), t.identifier];
      if (!g.touch0) g.touch0 = p;
      else if (!g.touch1) g.touch1 = p;
    }

    // If this is a dbltap, reroute to the (optional) dblclick.zoom handler.
    if (touchstarting) {
      touchstarting = clearTimeout(touchstarting);
      if (!g.touch1) {
        g.end();
        p = select(this).on("dblclick.zoom");
        if (p) p.apply(this, arguments);
        return;
      }
    }

    if (event.touches.length === n) {
      touchstarting = setTimeout(function() { touchstarting = null; }, touchDelay);
      interrupt(this);
      g.start();
    }
  }

  function touchmoved() {
    var g = gesture(this, arguments),
      touches = event.changedTouches,
      n = touches.length, i, t, p, l;

    noevent();
    if (touchstarting) touchstarting = clearTimeout(touchstarting);
    for (i = 0; i < n; ++i) {
      t = touches[i], p = touch(this, touches, t.identifier);
      if (g.touch0 && g.touch0[2] === t.identifier) g.touch0[0] = p;
      else if (g.touch1 && g.touch1[2] === t.identifier) g.touch1[0] = p;
    }
    t = g.that.__zoom;
    if (g.touch1) {
      var p0 = g.touch0[0], l0 = g.touch0[1],
        p1 = g.touch1[0], l1 = g.touch1[1],
        dp = (dp = p1[0] - p0[0]) * dp + (dp = p1[1] - p0[1]) * dp,
        dl = (dl = l1[0] - l0[0]) * dl + (dl = l1[1] - l0[1]) * dl;
      t = scale(t, Math.sqrt(dp / dl), Math.sqrt(dp / dl));
      p = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      l = [(l0[0] + l1[0]) / 2, (l0[1] + l1[1]) / 2];
    }
    else if (g.touch0) p = g.touch0[0], l = g.touch0[1];
    else return;
    g.zoom("touch", constrain(translate(t, p, l), g.extent));
  }

  function touchended() {
    var g = gesture(this, arguments),
      touches = event.changedTouches,
      n = touches.length, i, t;

    nopropagation();
    if (touchending) clearTimeout(touchending);
    touchending = setTimeout(function() { touchending = null; }, touchDelay);
    for (i = 0; i < n; ++i) {
      t = touches[i];
      if (g.touch0 && g.touch0[2] === t.identifier) delete g.touch0;
      else if (g.touch1 && g.touch1[2] === t.identifier) delete g.touch1;
    }
    if (g.touch1 && !g.touch0) g.touch0 = g.touch1, delete g.touch1;
    if (g.touch0) g.touch0[1] = this.__zoom.invert(g.touch0[0]);
    else g.end();
  }

  function constrainScaleExtent() {
    kx0 = x1 !== x0 ? Math.max(kx0u, (extent()[1][0] - extent()[0][0]) / (x1 - x0)) : Infinity;
    ky0 = y1 !== y0 ? Math.max(ky0u, (extent()[1][1] - extent()[0][1]) / (y1 - y0)) : Infinity;
  }

  zoom.clickDistance = function(_) {
    return arguments.length ? (clickDistance2 = (_ = +_) * _, zoom) : Math.sqrt(clickDistance2);
  }

  zoom.wheelDelta = function(_) {
    return arguments.length ? (wheelDelta = typeof _ === "function" ? _ : constant(+_), zoom) : wheelDelta;
  }

  zoom.filter = function(_) {
    return arguments.length ? (filter = typeof _ === "function" ? _ : constant(!!_), zoom) : filter;
  };

  zoom.extent = function(_) {
    return arguments.length ? (extent = typeof _ === "function" ? _ : constant([[+_[0][0], +_[0][1]], [+_[1][0], +_[1][1]]]), constrainScaleExtent(), zoom) : extent;
  };

  zoom.scaleExtent = function(_) {
    if (arguments.length) {
      if (Array.isArray(_[0])) {
        kx0u = +_[0][0];
        kx1 = +_[0][1];
        ky0u = +_[1][0];
        ky1 = +_[1][1];
      } else {
        kx0u = +_[0];
        kx1 = +_[1];
        ky0u = kx0u;
        ky1 = kx1;
      }
      constrainScaleExtent();
      return zoom;
    }
    return [[kx0u, kx1], [ky0u, ky1]];
  };

  zoom.scaleRatio = function(_) {
    return arguments.length ? (rx = +_[0], ry = +_[1], zoom) : [rx, ry];
  };

  zoom.translateExtent = function(_) {
    return arguments.length ? (x0 = +_[0][0], x1 = +_[1][0], y0 = +_[0][1], y1 = +_[1][1], constrainScaleExtent(), zoom) : [[x0, y0], [x1, y1]];
  };

  zoom.duration = function(_) {
    return arguments.length ? (duration = +_, zoom) : duration;
  };

  zoom.interpolate = function(_) {
    return arguments.length ? (interpolate = _, zoom) : interpolate;
  };

  zoom.on = function() {
    var value = listeners.on.apply(listeners, arguments);
    return value === listeners ? zoom : value;
  };

  return zoom;
}
