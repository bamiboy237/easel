from manim import *
from easel import *


class Lesson(EaselScene):
    def construct(self):
        self.title("Ordering a book online", "One order, from the shop's page to the warehouse and back")
        # LAYOUT: five nodes on a 3 x 2 grid filling the stage; names inside cards;
        # each link labelled beside its middle; out and back in separate lanes.
        shop = node("Shop page", [-4.6, 1.2], color=BLUE)
        api = node("Order service", [0.0, 1.2])
        pay = node("Payments", [4.6, 1.2], note="card check")
        stock = node("Warehouse", [0.0, -1.6])
        mail = node("Email", [4.6, -1.6], color=GREEN)
        self.play(LaggedStart(*[FadeIn(n, shift=0.1 * UP) for n in (shop, api, pay, stock, mail)], lag_ratio=0.15), run_time=1.6)

        order = connect(shop, api, label="place order", lane=0.18, color=RED)
        charge = connect(api, pay, label="charge card", lane=0.18, color=RED)
        paid = connect(pay, api, label="paid", lane=0.18, color=GREEN)
        pick = connect(api, stock, label="reserve book", color=RED, side=RIGHT)
        tell = connect(stock, mail, label="shipped", color=GREEN)
        done = connect(api, shop, label="confirmed", lane=0.18, color=GREEN)
        dot_ = packet(RED)

        # One step at a time: the link appears, the packet travels it, the caption says why.
        for link, words in [
            (order, "The page sends the order"),
            (charge, "The service asks for payment"),
            (paid, "Payment says yes"),
            (pick, "The warehouse reserves the book"),
            (tell, "A shipping email goes out"),
            (done, "The page shows the confirmation"),
        ]:
            self.caption(words)
            self.play(GrowArrow(link[0]), FadeIn(link[1]), run_time=0.6)
            if dot_ not in self.mobjects:
                self.add(dot_)
            dot_[1].set_color(link[0].get_color())
            self.play(travel(dot_, link, run_time=0.9))
        self.play(FadeOut(dot_))
        self.add(legend((RED, "request"), (GREEN, "answer")).to_corner(DL, buff=0.6).shift(0.9 * UP))
        self.caption("Every request gets its answer on its own lane")
        self.end()
